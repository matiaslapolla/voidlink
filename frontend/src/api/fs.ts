import { invoke } from "@tauri-apps/api/core";

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
}

export const fsApi = {
  listDir(path: string, includeIgnored?: boolean): Promise<FsEntry[]> {
    return invoke<FsEntry[]>("fs_list_dir", { path, includeIgnored: includeIgnored ?? false });
  },

  readFile(path: string): Promise<string> {
    return invoke<string>("fs_read_file", { path });
  },

  writeFile(path: string, content: string): Promise<void> {
    return invoke<void>("fs_write_file", { path, content });
  },

  createFile(path: string): Promise<void> {
    return invoke<void>("fs_create_file", { path });
  },

  createDir(path: string): Promise<void> {
    return invoke<void>("fs_create_dir", { path });
  },

  rename(from: string, to: string): Promise<void> {
    return invoke<void>("fs_rename", { from, to });
  },

  delete(path: string): Promise<void> {
    return invoke<void>("fs_delete", { path });
  },
};
