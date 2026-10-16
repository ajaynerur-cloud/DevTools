// DevHub-Portable.exe: runs DevHub on Windows with no installation, no admin rights and no server.
// It carries DevHub.html inside itself, writes it to the user's local app-data folder, and opens it
// in Edge (or Chrome) as an app window. Nothing else is installed or changed on the computer.
package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

//go:embed DevHub.html
var page []byte

func browsers() []string {
	var out []string
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
		if base == "" {
			continue
		}
		out = append(out,
			filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
	}
	return out
}

func message(text string) {
	// A small native message box, because this program has no console window.
	user32 := syscall.NewLazyDLL("user32.dll")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("DevHub")
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
}

func main() {
	dir := filepath.Join(os.Getenv("LocalAppData"), "DevHub-Portable")
	if os.Getenv("LocalAppData") == "" {
		dir = filepath.Join(os.TempDir(), "DevHub-Portable")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		message("DevHub could not create its folder:\n" + err.Error())
		os.Exit(1)
	}
	file := filepath.Join(dir, "DevHub.html")
	sum := sha256.Sum256(page)
	stamp := filepath.Join(dir, "DevHub.sha256")
	if old, err := os.ReadFile(stamp); err != nil || string(old) != hex.EncodeToString(sum[:]) {
		if err := os.WriteFile(file, page, 0o600); err != nil {
			message("DevHub could not write its page:\n" + err.Error())
			os.Exit(1)
		}
		_ = os.WriteFile(stamp, []byte(hex.EncodeToString(sum[:])), 0o600)
	} else if _, err := os.Stat(file); err != nil {
		_ = os.WriteFile(file, page, 0o600)
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(file)}
	for _, b := range browsers() {
		if _, err := os.Stat(b); err == nil {
			// Same browser profile as always, so DevHub's saved settings stay between runs.
			if err := exec.Command(b, "--app="+u.String()).Start(); err == nil {
				return
			}
		}
	}
	// No Edge or Chrome found: open it in the default browser.
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String()).Start(); err != nil {
		message(fmt.Sprintf("DevHub could not open a browser.\nOpen this file yourself:\n%s", file))
		os.Exit(1)
	}
}
