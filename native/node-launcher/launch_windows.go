package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const (
	createSuspended          = 0x00000004
	createNoWindow           = 0x08000000
	killOnJobClose           = 0x00002000
	extendedLimitInformation = 9
	infinite                 = 0xffffffff
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var createJobObject = kernel32.NewProc("CreateJobObjectW")
var setJobInformation = kernel32.NewProc("SetInformationJobObject")
var assignJobProcess = kernel32.NewProc("AssignProcessToJobObject")
var resumeThread = kernel32.NewProc("ResumeThread")

type jobBasicLimits struct {
	ProcessUserTime    int64
	JobUserTime        int64
	Flags              uint32
	MinimumWorkingSet  uintptr
	MaximumWorkingSet  uintptr
	ActiveProcessLimit uint32
	Affinity           uintptr
	PriorityClass      uint32
	SchedulingClass    uint32
}
type ioCounters struct{ ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes uint64 }
type jobExtendedLimits struct {
	Basic                 jobBasicLimits
	IO                    ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func launchNative(electron string, args, env []string) (uint32, error) {
	application, err := syscall.UTF16PtrFromString(electron)
	if err != nil {
		return 0, errors.New("invalid Electron path")
	}
	line, err := syscall.UTF16FromString(commandLine(electron, args))
	if err != nil {
		return 0, errors.New("invalid Node argument")
	}
	block, err := environmentBlock(env)
	if err != nil {
		return 0, err
	}
	current, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	handles := make([]syscall.Handle, 0, 3)
	defer func() {
		for _, handle := range handles {
			syscall.CloseHandle(handle)
		}
	}()
	for _, file := range []*os.File{os.Stdin, os.Stdout, os.Stderr} {
		handle, err := duplicateStandardHandle(current, file)
		if err != nil {
			return 0, fmt.Errorf("cannot inherit standard stream: %w", err)
		}
		handles = append(handles, handle)
	}
	job, _, last := createJobObject.Call(0, 0)
	if job == 0 {
		return 0, fmt.Errorf("cannot create Node process job: %w", last)
	}
	defer syscall.CloseHandle(syscall.Handle(job))
	limits := jobExtendedLimits{}
	limits.Basic.Flags = killOnJobClose
	if ok, _, last := setJobInformation.Call(job, extendedLimitInformation, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); ok == 0 {
		return 0, fmt.Errorf("cannot configure Node process job: %w", last)
	}
	startup := syscall.StartupInfo{Flags: syscall.STARTF_USESTDHANDLES | syscall.STARTF_USESHOWWINDOW, StdInput: handles[0], StdOutput: handles[1], StdErr: handles[2]}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	var process syscall.ProcessInformation
	// Suspend before assignment so a killed launcher cannot leave a running
	// Electron child outside the job. A nil cwd preserves the caller's cwd.
	if err = syscall.CreateProcess(application, &line[0], nil, nil, true, createSuspended|createNoWindow|syscall.CREATE_UNICODE_ENVIRONMENT, &block[0], nil, &startup, &process); err != nil {
		return 0, fmt.Errorf("cannot start Electron Node runtime: %w", err)
	}
	defer syscall.CloseHandle(process.Process)
	defer syscall.CloseHandle(process.Thread)
	if ok, _, last := assignJobProcess.Call(job, uintptr(process.Process)); ok == 0 {
		syscall.TerminateProcess(process.Process, 1)
		return 0, fmt.Errorf("cannot own Electron Node process: %w", last)
	}
	if result, _, last := resumeThread.Call(uintptr(process.Thread)); result == uintptr(0xffffffff) {
		syscall.TerminateProcess(process.Process, 1)
		return 0, fmt.Errorf("cannot resume Electron Node process: %w", last)
	}
	if _, err = syscall.WaitForSingleObject(process.Process, infinite); err != nil {
		return 0, err
	}
	var code uint32
	if err = syscall.GetExitCodeProcess(process.Process, &code); err != nil {
		return 0, err
	}
	runtime.KeepAlive(line)
	runtime.KeepAlive(block)
	return code, nil
}
func duplicateStandardHandle(current syscall.Handle, file *os.File) (syscall.Handle, error) {
	source := syscall.Handle(file.Fd())
	var destination syscall.Handle
	err := syscall.DuplicateHandle(current, source, current, &destination, 0, true, syscall.DUPLICATE_SAME_ACCESS)
	if err == nil {
		return destination, nil
	}
	if err != syscall.Errno(6) { // ERROR_INVALID_HANDLE
		return 0, err
	}
	null, openErr := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if openErr != nil {
		return 0, openErr
	}
	defer null.Close()
	err = syscall.DuplicateHandle(current, syscall.Handle(null.Fd()), current, &destination, 0, true, syscall.DUPLICATE_SAME_ACCESS)
	return destination, err
}
func environmentBlock(env []string) ([]uint16, error) {
	var block []uint16
	for _, entry := range env {
		for _, r := range entry {
			if r == 0 {
				return nil, errors.New("invalid child environment")
			}
		}
		block = append(block, utf16.Encode([]rune(entry))...)
		block = append(block, 0)
	}
	block = append(block, 0)
	if len(block) == 1 {
		block = append(block, 0)
	}
	return block, nil
}
