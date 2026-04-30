export interface YtDlpOptions {
  url?: string;
  output?: string;
  format?: string;
  quality?: string;
  subtitles?: boolean;
  writeSub?: boolean;
  writeAutoSub?: boolean;
  subLang?: string;
  embedSubs?: boolean;
  [key: string]: any;
}

export interface DownloadResult {
  success: boolean;
  filename?: string;
  error?: string;
  data?: any;
}

export interface VideoInfo {
  id: string;
  title: string;
  uploader: string;
  uploaderId?: string;
  duration?: number;
  viewCount?: number;
  thumbnail?: string;
  description?: string;
  uploadDate?: string;
  formats?: Format[];
  [key: string]: any;
}

export interface Format {
  formatId: string;
  ext: string;
  resolution?: string;
  fps?: number;
  filesize?: number;
  tbr?: number;
  vbr?: number;
  abr?: number;
  acodec?: string;
  vcodec?: string;
  container?: string;
  [key: string]: any;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BinaryInfo {
  path: string;
  version: string;
  platform: string;
  arch: string;
}
