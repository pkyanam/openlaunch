package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func fileRevision(st os.FileInfo) string {
	identity := ""
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		identity = fmt.Sprintf("%d:%d", sys.Dev, sys.Ino)
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:%s", st.Name(), st.Size(), st.ModTime().UnixNano(), identity)))
	return hex.EncodeToString(sum[:])
}
func ordinary(st os.FileInfo) bool {
	if !st.Mode().IsRegular() {
		return false
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && sys.Nlink > 1 {
		return false
	}
	return true
}
func rootFile(root *os.Root, path string, flags int, mode os.FileMode) (*os.File, error) {
	st, e := root.Lstat(path)
	if e == nil && !ordinary(st) {
		return nil, errors.New("only regular, singly linked files are supported")
	}
	if e != nil && !(flags&os.O_CREATE != 0 && errors.Is(e, os.ErrNotExist)) {
		return nil, e
	}
	f, e := root.OpenFile(path, flags|syscall.O_NONBLOCK, mode)
	if e != nil {
		return nil, e
	}
	st, e = f.Stat()
	if e != nil || !ordinary(st) {
		f.Close()
		return nil, errors.New("unsupported file type")
	}
	return f, nil
}
func localPath(path string) bool {
	return filepath.IsLocal(path) && len(path) <= 256 && !strings.ContainsRune(path, 0)
}
func (h *LinuxHarness) fileRoot(args map[string]any, write bool) (*os.Root, string, error) {
	alias, _ := args["root"].(string)
	path, _ := args["path"].(string)
	r := h.Roots[alias]
	p, ok := h.Policy.Roots[alias]
	if !ok || r == nil || (write && !p.Write) {
		return nil, "", errors.New("root access denied")
	}
	if !localPath(path) {
		return nil, "", errors.New("use a relative path inside the named root")
	}
	return r, path, nil
}
func (h *LinuxHarness) files(cmd Command) (any, error) {
	if cmd.Capability == "file.upload_abort" {
		return h.abortUpload(cmd.Args)
	}
	write := cmd.Capability == "file.write" || cmd.Capability == "file.remove" || cmd.Capability == "file.mkdir"
	r, path, e := h.fileRoot(cmd.Args, write)
	if e != nil {
		return nil, e
	}
	switch cmd.Capability {
	case "file.stat":
		st, e := r.Lstat(path)
		if e != nil {
			return nil, e
		}
		if !st.IsDir() && !ordinary(st) {
			return nil, errors.New("unsupported file type")
		}
		return map[string]any{"size": st.Size(), "directory": st.IsDir(), "modifiedAt": st.ModTime().UTC().Format(time.RFC3339Nano), "revision": fileRevision(st)}, nil
	case "file.list":
		f, e := r.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil || !st.IsDir() {
			return nil, errors.New("not a directory")
		}
		offset := intArg(cmd.Args, "offset", 0)
		// Stream rather than loading an arbitrarily large directory into memory.
		for skipped := int64(0); skipped < offset; {
			n := min(offset-skipped, 64)
			entries, e := f.ReadDir(int(n))
			skipped += int64(len(entries))
			if e != nil {
				return map[string]any{"entries": []any{}, "nextOffset": offset, "eof": true}, nil
			}
			if h.Context.Err() != nil || time.Now().UnixMilli() >= cmd.ExpiresAt {
				return nil, errors.New("expired directory scan")
			}
		}
		entries, e := f.ReadDir(12)
		if e != nil && e != io.EOF {
			return nil, e
		}
		out := make([]any, 0, len(entries))
		for _, entry := range entries {
			item := map[string]any{"name": entry.Name(), "directory": entry.IsDir(), "symlink": entry.Type()&os.ModeSymlink != 0}
			probe := append(append([]any{}, out...), item)
			b, _ := json.Marshal(probe)
			if len(b) > 3400 {
				e = nil
				break
			}
			out = append(out, item)
		}
		return map[string]any{"entries": out, "nextOffset": offset + int64(len(out)), "eof": e == io.EOF, "revision": fileRevision(st)}, nil
	case "file.read":
		f, e := rootFile(r, path, os.O_RDONLY, 0)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil {
			return nil, e
		}
		offset := intArg(cmd.Args, "offset", 0)
		limit := intArg(cmd.Args, "limit", 2048)
		data := make([]byte, limit)
		n, e := f.ReadAt(data, offset)
		if e != nil && e != io.EOF {
			return nil, e
		}
		after, e := f.Stat()
		if e != nil || fileRevision(st) != fileRevision(after) {
			return nil, errors.New("file changed during read; restart the transfer")
		}
		return map[string]any{"dataBase64": base64.StdEncoding.EncodeToString(data[:n]), "nextOffset": offset + int64(n), "eof": offset+int64(n) >= st.Size(), "size": st.Size(), "revision": fileRevision(st)}, nil
	case "file.mkdir":
		if path == "." {
			return nil, errors.New("cannot modify root")
		}
		if e := r.Mkdir(path, 0700); e != nil {
			return nil, e
		}
		return map[string]any{"created": true}, nil
	case "file.remove":
		if filepath.Clean(path) == "." {
			return nil, errors.New("cannot remove root")
		}
		st, e := r.Lstat(path)
		if e != nil {
			return nil, e
		}
		if !st.IsDir() && !ordinary(st) {
			return nil, errors.New("unsupported file type")
		}
		if e := r.Remove(path); e != nil {
			return nil, e
		}
		return map[string]any{"removed": true}, nil
	case "file.write":
		return h.writeChunk(r, path, cmd)
	}
	return nil, errors.New("unsupported file function")
}

type Upload struct {
	Root            string `json:"root"`
	Path            string `json:"path"`
	Policy          string `json:"policy"`
	ReplaceRevision string `json:"replaceRevision"`
	CreatedAt       int64  `json:"createdAt"`
}

func (h *LinuxHarness) uploadPaths(id string) (string, string, error) {
	if !isUUID(id) {
		return "", "", errors.New("uploadId must be a UUID")
	}
	base := filepath.Join(h.State, "upload-"+strings.ToLower(id))
	return base + ".json", base + ".part", nil
}
func privateRead(path string, value any) error {
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !ordinary(st) || st.Mode().Perm()&0077 != 0 || st.Size() > 32768 {
		return errors.New("invalid private transfer metadata")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, value)
}
func (h *LinuxHarness) cleanupUploads() (int, int64, error) {
	entries, e := os.ReadDir(h.State)
	if e != nil {
		return 0, 0, e
	}
	count := 0
	var size int64
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "upload-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		meta := filepath.Join(h.State, entry.Name())
		part := strings.TrimSuffix(meta, ".json") + ".part"
		var u Upload
		if e := privateRead(meta, &u); e != nil {
			return 0, 0, e
		}
		if time.Now().UnixMilli()-u.CreatedAt > int64(time.Hour/time.Millisecond) {
			if e = os.Remove(part); e != nil && !errors.Is(e, os.ErrNotExist) {
				return 0, 0, e
			}
			if e = os.Remove(meta); e != nil {
				return 0, 0, e
			}
			continue
		}
		count++
		st, e := os.Lstat(part)
		if e == nil {
			if !ordinary(st) || st.Mode().Perm()&0077 != 0 {
				return 0, 0, errors.New("invalid private transfer data")
			}
			size += st.Size()
		} else if !errors.Is(e, os.ErrNotExist) {
			return 0, 0, e
		}
	}
	return count, size, nil
}
func (h *LinuxHarness) abortUpload(args map[string]any) (any, error) {
	id, _ := args["uploadId"].(string)
	meta, part, e := h.uploadPaths(id)
	if e != nil {
		return nil, e
	}
	for _, path := range []string{part, meta} {
		if e = os.Remove(path); e != nil && !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
	}
	return map[string]any{"aborted": true}, nil
}
func (h *LinuxHarness) writeChunk(root *os.Root, path string, cmd Command) (any, error) {
	a := cmd.Args
	final, _ := a["final"].(bool)
	digest, _ := a["sha256"].(string)
	if final && !isLowerHex(digest, 64) {
		return nil, errors.New("final chunk requires lowercase SHA-256")
	}
	id, _ := a["uploadId"].(string)
	meta, part, e := h.uploadPaths(id)
	if e != nil {
		return nil, e
	}
	count, total, e := h.cleanupUploads()
	if e != nil {
		return nil, e
	}
	encoded, _ := a["dataBase64"].(string)
	chunk, e := base64.StdEncoding.Strict().DecodeString(encoded)
	if e != nil || len(chunk) > 6144 {
		return nil, errors.New("invalid base64 chunk (maximum 6144 bytes)")
	}
	offset := intArg(a, "offset", 0)
	replace, _ := a["replaceRevision"].(string)
	alias, _ := a["root"].(string)
	var upload Upload
	e = privateRead(meta, &upload)
	if errors.Is(e, os.ErrNotExist) {
		if offset != 0 {
			return nil, errors.New("first upload offset must be zero")
		}
		if count >= 4 {
			return nil, errors.New("at most four unfinished uploads are allowed")
		}
		upload = Upload{alias, path, h.Revision, replace, time.Now().UnixMilli()}
		if e = atomic(meta, upload); e != nil {
			return nil, e
		}
	} else if e != nil {
		return nil, e
	}
	if upload.Root != alias || upload.Path != path || upload.Policy != h.Revision || upload.ReplaceRevision != replace {
		return nil, errors.New("upload parameters changed")
	}
	if total+int64(len(chunk)) > 2<<20 {
		return nil, errors.New("unfinished uploads exceed 2 MiB")
	}
	f, e := os.OpenFile(part, os.O_CREATE|os.O_RDWR|syscall.O_NONBLOCK, 0600)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !ordinary(st) || st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("invalid private upload")
	}
	if st.Size() != offset {
		return nil, fmt.Errorf("out-of-order chunk; expected offset %d", st.Size())
	}
	if offset+int64(len(chunk)) > 2<<20 {
		return nil, errors.New("file exceeds 2 MiB")
	}
	if _, e = f.WriteAt(chunk, offset); e != nil {
		return nil, e
	}
	if e = f.Sync(); e != nil {
		return nil, e
	}
	next := offset + int64(len(chunk))
	if !final {
		return map[string]any{"uploadId": id, "nextOffset": next, "committed": false}, nil
	}
	if _, e = f.Seek(0, 0); e != nil {
		return nil, e
	}
	hash := sha256.New()
	if _, e = io.Copy(hash, f); e != nil {
		return nil, e
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return nil, errors.New("SHA-256 mismatch; abort and retry the upload")
	}
	// Stage beside the destination so publication is atomic even on another filesystem.
	tmpName := ".openlaunch-" + strings.ToLower(id) + ".tmp"
	dir := filepath.Dir(path)
	tmpPath := filepath.Join(dir, tmpName)
	out, e := root.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return nil, e
	}
	defer root.Remove(tmpPath)
	if _, e = f.Seek(0, 0); e == nil {
		_, e = io.Copy(out, f)
	}
	if e == nil {
		e = out.Sync()
	}
	closeErr := out.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return nil, e
	}
	if h.Context.Err() != nil || time.Now().UnixMilli() >= cmd.ExpiresAt {
		return nil, errors.New("expired before file publication")
	}
	if replace == "" {
		// Link is atomic create-if-absent. Rename would silently overwrite.
		if e = root.Link(tmpPath, path); e != nil {
			return nil, e
		}
		if e = root.Remove(tmpPath); e != nil {
			return nil, e
		}
	} else {
		current, e := root.Lstat(path)
		if e != nil || !ordinary(current) || fileRevision(current) != replace {
			return nil, errors.New("replacement revision mismatch")
		}
		if e = root.Rename(tmpPath, path); e != nil {
			return nil, e
		}
	}
	directory, e := root.Open(dir)
	if e != nil {
		return nil, e
	}
	e = directory.Sync()
	directory.Close()
	if e != nil {
		return nil, e
	}
	if _, e = h.abortUpload(a); e != nil {
		return nil, e
	}
	return map[string]any{"uploadId": id, "nextOffset": next, "committed": true, "sha256": digest}, nil
}
