// Minimal ambient declarations for the parts of the File System Access API
// that TypeScript's DOM lib does not yet ship: the directory picker and the
// per-handle permission methods. All are optional so callers must feature-
// detect before use (story 7.4 backup folder).

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: string
}

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
}

interface FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
  requestPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
}
