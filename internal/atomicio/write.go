//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package atomicio

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// WriteFile writes data to path the way os.WriteFile does, except that no
// reader, crash or racing writer can ever see a partial file: the bytes go to a
// temp file of their own in the same directory, are synced to disk, and are then
// published over path with RobustRename. Whatever path holds afterwards is one
// complete write — the old file or the new one, never a torn mix — and when two
// writers race, the last rename wins whole.
//
// perm is the file's mode exactly, with no umask applied, whether path existed
// or not. Use 0600 for anything that can hold a secret.
//
// The directory must exist. On failure path is untouched and the temp file is
// removed.
func WriteFile(path string, data []byte, perm os.FileMode) (err error) {
	dir, base := filepath.Split(path)
	if dir == "" {
		dir = "."
	}
	// Each write gets its own temp (a shared name would itself collide between
	// racing writers), dot-prefixed so a directory listing never mistakes it
	// for the real file.
	tmp, err := os.CreateTemp(dir, "."+base+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	// Synced before the rename, or a crash just after it could publish a name
	// whose data blocks never reached the disk.
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return RobustRename(tmpName, path)
}

// RemoveTemps deletes the temp files WriteFile leaves beside path when its
// process dies between creating one and publishing it — killed, crashed, or
// exited mid-sync. WriteFile's own cleanup covers every failure it lives to
// see; nothing else ever removes these.
//
// It also deletes a temp that another writer is still filling, whose publish
// then fails. Call it only where nothing else can be writing path: from its
// sole writer, before that writer's first write.
//
// A directory that does not exist holds no temps and is not an error.
func RemoveTemps(path string) error {
	dir, base := filepath.Split(path)
	if dir == "" {
		dir = "."
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	var errs []error
	for _, e := range entries {
		if isTempOf(e.Name(), base) {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// isTempOf reports whether name is one WriteFile's CreateTemp pattern
// ("."+base+".*.tmp") generates for base: CreateTemp fills the * with decimal
// digits only.
func isTempOf(name, base string) bool {
	mid, ok := strings.CutPrefix(name, "."+base+".")
	if !ok {
		return false
	}
	mid, ok = strings.CutSuffix(mid, ".tmp")
	if !ok || mid == "" {
		return false
	}
	for _, c := range mid {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
