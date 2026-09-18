package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func windowsFixtureLauncher(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	output := filepath.Join(dir, "node.exe")
	cmd := exec.Command("go", "build", "-buildvcs=false", "-ldflags=-H=windowsgui", "-o", output, ".")
	if data, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build launcher: %v: %s", err, data)
	}
	fixture, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"electronPath": fixture})
	if err = os.WriteFile(filepath.Join(dir, configName), data, 0600); err != nil {
		t.Fatal(err)
	}
	return output
}
func TestWindowsLauncherTransparentProcess(t *testing.T) {
	launcher := windowsFixtureLauncher(t)
	cwd := t.TempDir()
	want := []string{"", "中文 参数", `trailing\`, `quotes"and\`, "%PATH%&literal"}
	args := append([]string{"-test.run=^TestWindowsLauncherChild$", "--"}, want...)
	cmd := exec.Command(launcher, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "DESKTOP_NODE_LAUNCHER_TEST=inspect", "ELECTRON_RUN_AS_NODE=0", "PRIVATE_TEST_VALUE=kept")
	cmd.Stdin = strings.NewReader("stdin preserved")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 19 {
		t.Fatal("exit code was not forwarded", err, stderr.String())
	}
	var got struct {
		Args                           []string
		Cwd, Input, RunAsNode, Private string
	}
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatal(err, stdout.String(), stderr.String())
	}
	if !reflect.DeepEqual(got.Args, want) || !strings.EqualFold(got.Cwd, cwd) || got.Input != "stdin preserved" || got.RunAsNode != "1" || got.Private != "kept" || stderr.String() != "stderr preserved" {
		t.Fatalf("process forwarding failed: %#v stderr=%q", got, stderr.String())
	}
}
func TestWindowsLauncherDeathStopsOwnedElectron(t *testing.T) {
	launcher := windowsFixtureLauncher(t)
	marker := filepath.Join(t.TempDir(), "child.pid")
	cmd := exec.Command(launcher, "-test.run=^TestWindowsLauncherChild$")
	cmd.Env = append(os.Environ(), "DESKTOP_NODE_LAUNCHER_TEST=wait", "DESKTOP_NODE_LAUNCHER_MARKER="+marker)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	var pid int
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(marker); err == nil {
			pid, _ = strconv.Atoi(string(data))
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("owned child never started")
	}
	child, err := syscall.OpenProcess(0x00100000|0x0001, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(child)
	defer syscall.TerminateProcess(child, 1)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	state, err := syscall.WaitForSingleObject(child, 3000)
	if err != nil || state != 0 {
		t.Fatal("launcher death left Electron child alive", state, err)
	}
}
func TestWindowsLauncherChild(t *testing.T) {
	mode := os.Getenv("DESKTOP_NODE_LAUNCHER_TEST")
	if mode == "" {
		return
	}
	if mode == "wait" {
		os.WriteFile(os.Getenv("DESKTOP_NODE_LAUNCHER_MARKER"), []byte(strconv.Itoa(os.Getpid())), 0600)
		time.Sleep(60 * time.Second)
		os.Exit(0)
	}
	input, _ := io.ReadAll(os.Stdin)
	cwd, _ := os.Getwd()
	args := []string{}
	for index, arg := range os.Args {
		if arg == "--" {
			args = os.Args[index+1:]
			break
		}
	}
	json.NewEncoder(os.Stdout).Encode(struct {
		Args                           []string
		Cwd, Input, RunAsNode, Private string
	}{args, cwd, string(input), os.Getenv("ELECTRON_RUN_AS_NODE"), os.Getenv("PRIVATE_TEST_VALUE")})
	os.Stderr.WriteString("stderr preserved")
	os.Exit(19)
}
