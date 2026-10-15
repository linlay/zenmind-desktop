package server

// Opt-in local integration fixture: production Platform HTTP handlers and real MCP
// validation, with only the upstream service mocked. All data lives in t.TempDir.
import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"agent-platform/internal/llm"
	platformmcp "agent-platform/internal/mcp"
	"agent-platform/internal/reload"
	"agent-platform/internal/tools"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestDesktopConnectorFirstBatchBridgeLocal(t *testing.T) {
	output := os.Getenv("DESKTOP_CONNECTOR_BRIDGE_FILE")
	if output == "" {
		t.Skip("opt-in Desktop integration fixture")
	}
	sdk := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "desktop-bridge-upstream", Version: "1"}, nil)
	sdk.AddTool(&sdkmcp.Tool{Name: "read_document", InputSchema: json.RawMessage(`{"type":"object"}`)}, func(context.Context, *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return &sdkmcp.CallToolResult{Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: "fixture document"}}}, nil
	})
	handler := sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server { return sdk }, &sdkmcp.StreamableHTTPOptions{JSONResponse: true})
	var tokenProbes atomic.Int64
	var candidateAvailable atomic.Bool
	var slowDiscovery atomic.Bool
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if slowDiscovery.Load() && r.URL.Path == "/mcp" && r.Method == http.MethodPost {
			time.Sleep(1500 * time.Millisecond)
		}
		if r.URL.Path == "/token-mcp" {
			tokenProbes.Add(1)
			key := r.Header.Get("X-API-Key")
			if key == "fixture-next-token" && !candidateAvailable.Load() {
				http.Error(w, "temporarily unavailable", 503)
				return
			}
			if key != "fixture-valid-token" && key != "fixture-next-token" {
				http.Error(w, "unauthorized", 401)
				return
			}
		}
		handler.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	fixture := newTestFixture(t)
	root := fixture.server.deps.Config.Paths.EffectiveConnectorsCenterDir()
	for _, id := range []string{"bridge-none", "bridge-token", "bridge-oauth"} {
		writeMCPConnectorForTest(t, root, id)
		manifest := map[string]any{"id": id, "name": id, "version": "1.0.0", "type": "mcp", "authMode": "self"}
		component := map[string]any{"type": "streamableHttp", "url": upstream.URL + "/mcp"}
		files := map[string]any{"connector.json": manifest, "mcp.json": map[string]any{"mcpServers": map[string]any{"main": component}}}
		if id == "bridge-token" {
			manifest["authMode"] = "token"
			files["token-schema.json"] = map[string]any{"fields": []map[string]any{{"key": "API_KEY", "label": "API key", "type": "password", "required": true}}}
			component["url"] = upstream.URL + "/token-mcp"
			component["headers"] = map[string]any{"X-API-Key": "${API_KEY}"}
		}
		if id == "bridge-oauth" {
			manifest["authMode"] = "oauth"
			manifest["authBrowser"] = "embedded"
			manifest["oauth"] = map[string]any{"clientId": "fixture-client", "authorizationEndpoint": upstream.URL + "/authorize", "tokenEndpoint": upstream.URL + "/token", "resource": upstream.URL + "/mcp", "scopes": []string{"read"}}
		}
		for name, value := range files {
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(root, id, name), raw, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	registry, err := platformmcp.NewAgentRegistry(fixture.server.connectorSources())
	if err != nil {
		t.Fatal(err)
	}
	if err = registry.BindAgents(fixture.registry.(platformmcp.AgentConnectorSource)); err != nil {
		t.Fatal(err)
	}
	gate := platformmcp.NewAvailabilityGate()
	client := platformmcp.NewClientWithGate(registry, upstream.Client(), gate)
	defer client.Close()
	syncer := platformmcp.NewToolSync(registry, client)
	coordinator := platformmcp.NewSyncCoordinator(registry, syncer, gate, 100*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	coordinator.Start(ctx)
	router, err := tools.NewToolRouter(fixture.tools, client, syncer, llm.NewInteractionSubmitCoordinator(fixture.interactions))
	if err != nil {
		t.Fatal(err)
	}
	fixture.server.deps.MCP = client
	fixture.server.deps.Tools = router
	fixture.server.deps.MCPToolSyncStatus = syncer
	fixture.server.deps.CatalogReloader = reload.NewRuntimeCatalogReloader(fixture.registry, fixture.modelRegistry,
		platformmcp.NewRegistryReloader(registry, syncer, coordinator), router, fixture.cfg.Paths.ToolsDir, fixture.server.deps.Notifications)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fixture/slow-sync" && r.Method == http.MethodPost {
			slowDiscovery.Store(true)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path == "/fixture/probes" {
			_ = json.NewEncoder(w).Encode(map[string]any{"count": tokenProbes.Load()})
			return
		}
		if r.URL.Path == "/fixture/reset" && r.Method == http.MethodPost {
			candidateAvailable.Store(false)
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/fixture/recover" && r.Method == http.MethodPost {
			candidateAvailable.Store(true)
			w.WriteHeader(204)
			return
		}
		fixture.server.ServeHTTP(w, r)
	}))
	defer server.Close()
	raw, _ := json.Marshal(map[string]any{"url": server.URL, "upstream": upstream.URL, "runtimeRoot": filepath.Dir(root), "connectorsRoot": root, "ids": []string{"bridge-none", "bridge-token", "bridge-oauth"}, "token": "fixture-valid-token"})
	if err = os.WriteFile(output, raw, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("Desktop bridge ready at %s; stop by creating %s.stop", server.URL, output)
	for deadline := time.Now().Add(20 * time.Minute); time.Now().Before(deadline); {
		if _, err := os.Stat(output + ".stop"); err == nil {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("Desktop bridge timed out")
}
