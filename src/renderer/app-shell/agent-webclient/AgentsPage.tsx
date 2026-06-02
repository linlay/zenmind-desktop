import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AgentConsole } from "./AgentConsole";
import type { Agent } from "./types";

export function AgentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ agentKey?: string }>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const selectedAgentKey = String(params.agentKey || "").trim();
  const routeSearch = location.search || "";

  return (
    <main className="agents-page agent-webclient-native-page">
      <AgentConsole
        agents={agents}
        selectedAgentKey={selectedAgentKey}
        onAgentsChange={setAgents}
        onSelectAgentKey={(agentKey) => {
          navigate(`/agents/${encodeURIComponent(agentKey)}${routeSearch}`);
        }}
        onClearSelection={() => navigate(`/agents${routeSearch}`)}
      />
    </main>
  );
}
