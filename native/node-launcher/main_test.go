package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestConfigPathAndSelfRecursion(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "node.exe")
	electron := filepath.Join(root, "CuteJ.exe")
	os.WriteFile(launcher, []byte("launcher"), 0600)
	os.WriteFile(electron, []byte("electron"), 0600)
	save := func(value string) {
		data, _ := json.Marshal(map[string]string{"electronPath": value})
		os.WriteFile(filepath.Join(root, configName), data, 0600)
	}
	save(electron)
	if path, err := readElectronPath(launcher); err != nil || path != electron {
		t.Fatal(path, err)
	}
	for _, value := range []string{"relative.exe", launcher, filepath.Join(root, "missing.exe")} {
		save(value)
		if _, err := readElectronPath(launcher); err == nil {
			t.Fatal("accepted invalid runtime", value)
		}
	}
}
func TestConfigRejectsAmbiguity(t *testing.T) {
	for _, data := range []string{`{}`, `[]`, `{"electronPath":1}`, `{"electronPath":"x","electronPath":"y"}`, `{"electronPath":"x","extra":true}`, `{"electronPath":"x"} {}`} {
		if _, err := decodeElectronPath([]byte(data)); err == nil {
			t.Fatal("accepted", data)
		}
	}
}
func TestEnvironmentIsChildOnlyAndCaseInsensitive(t *testing.T) {
	original := []string{"HOME=C:\\private", "Path=C:\\runtime", "electron_run_as_node=0", "ELECTRON_RUN_AS_NODE=0", "ELECTRON_NO_ATTACH_CONSOLE=0", "TOKEN=private-test"}
	copyInput := append([]string{}, original...)
	env := nodeEnvironment(original)
	if !reflect.DeepEqual(original, copyInput) {
		t.Fatal("mutated parent environment")
	}
	joined := strings.Join(env, "\n")
	if strings.Count(joined, "ELECTRON_RUN_AS_NODE=") != 1 || !strings.Contains(joined, "ELECTRON_RUN_AS_NODE=1") || !strings.Contains(joined, "HOME=C:\\private") || !strings.Contains(joined, "TOKEN=private-test") {
		t.Fatal("child environment did not preserve caller values")
	}
}
func TestWindowsArgumentQuoting(t *testing.T) {
	for _, v := range []struct{ input, want string }{{"", `""`}, {"simple", "simple"}, {"a b", `"a b"`}, {`a"b`, `"a\"b"`}, {`C:\space dir\`, `"C:\space dir\\"`}, {`%PATH%&literal`, `%PATH%&literal`}, {"中文 参数", `"中文 参数"`}} {
		if got := quoteWindowsArgument(v.input); got != v.want {
			t.Fatalf("%q => %q wanted %q", v.input, got, v.want)
		}
	}
	if got := commandLine(`C:\Program Files\CuteJ.exe`, []string{"--version", ""}); got != `"C:\Program Files\CuteJ.exe" --version ""` {
		t.Fatal(got)
	}
}
