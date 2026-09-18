package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const configName = ".desktop-node-runtime.json"

func main() {
	launcher, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Desktop Node launcher cannot locate itself")
		os.Exit(1)
	}
	code, err := runLauncher(launcher, os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "Desktop Node launcher:", err)
		os.Exit(1)
	}
	os.Exit(int(code))
}

func runLauncher(launcher string, args []string) (uint32, error) {
	electron, err := readElectronPath(launcher)
	if err != nil {
		return 0, err
	}
	return launchNative(electron, args, nodeEnvironment(os.Environ()))
}

func readElectronPath(launcher string) (string, error) {
	path := filepath.Join(filepath.Dir(launcher), configName)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16*1024 {
		return "", errors.New("runtime configuration is missing or invalid")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot read runtime configuration")
	}
	electron, err := decodeElectronPath(data)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(electron) || strings.ContainsRune(electron, 0) {
		return "", errors.New("electronPath must be absolute")
	}
	target, err := os.Stat(electron)
	if err != nil || !target.Mode().IsRegular() {
		return "", errors.New("configured Electron executable is unavailable")
	}
	if self, err := os.Stat(launcher); err == nil && os.SameFile(self, target) {
		return "", errors.New("Electron executable cannot be the launcher itself")
	}
	return electron, nil
}

func decodeElectronPath(data []byte) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return "", errors.New("runtime configuration must be an object")
	}
	electron := ""
	seen := false
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return "", errors.New("invalid runtime configuration")
		}
		if token != "electronPath" || seen {
			return "", errors.New("runtime configuration has unexpected or duplicate fields")
		}
		seen = true
		if err = decoder.Decode(&electron); err != nil {
			return "", errors.New("electronPath must be a string")
		}
	}
	if _, err = decoder.Token(); err != nil {
		return "", errors.New("invalid runtime configuration")
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return "", errors.New("runtime configuration has trailing data")
	}
	if !seen || strings.TrimSpace(electron) == "" {
		return "", errors.New("electronPath is required")
	}
	return electron, nil
}

// This environment belongs only to the Electron child, not the Desktop or
// Platform parent. Preserve every other variable, including private CLI HOME.
func nodeEnvironment(input []string) []string {
	env := make([]string, 0, len(input)+2)
	for _, entry := range input {
		key, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "ELECTRON_RUN_AS_NODE") || strings.EqualFold(key, "ELECTRON_NO_ATTACH_CONSOLE") {
			continue
		}
		env = append(env, entry)
	}
	env = append(env, "ELECTRON_RUN_AS_NODE=1", "ELECTRON_NO_ATTACH_CONSOLE=1")
	sort.SliceStable(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
	return env
}

// Quote for the Windows argv convention, never cmd.exe shell text. Percent,
// ampersands and other shell syntax remain literal because no shell is invoked.
func quoteWindowsArgument(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\"") {
		return value
	}
	var out strings.Builder
	out.WriteByte('"')
	slashes := 0
	for i := 0; i < len(value); i++ {
		switch value[i] {
		case '\\':
			slashes++
		case '"':
			out.WriteString(strings.Repeat("\\", slashes*2+1))
			out.WriteByte('"')
			slashes = 0
		default:
			out.WriteString(strings.Repeat("\\", slashes))
			slashes = 0
			out.WriteByte(value[i])
		}
	}
	out.WriteString(strings.Repeat("\\", slashes*2))
	out.WriteByte('"')
	return out.String()
}
func commandLine(executable string, args []string) string {
	words := []string{quoteWindowsArgument(executable)}
	for _, arg := range args {
		words = append(words, quoteWindowsArgument(arg))
	}
	return strings.Join(words, " ")
}
