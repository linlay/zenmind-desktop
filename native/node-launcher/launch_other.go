//go:build !windows

package main

import "errors"

func launchNative(string, []string, []string) (uint32, error) {
	return 0, errors.New("the native Node launcher is Windows-only")
}
