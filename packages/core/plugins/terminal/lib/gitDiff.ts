import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { homedir } from 'os';

const execFileAsync = promisify(execFile);

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface FileDiff {
  file: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface GitDiffResult {
  isGit: boolean;
  repoRoot: string;
  files: FileDiff[];
  summary: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

/**
 * Parse a standard git unified diff output into structured file diffs.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff.trim()) return [];

  const files: FileDiff[] = [];
  const rawSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of rawSections) {
    const rawLines = section.split('\n');
    const headerLine = rawLines[0] || '';
    // e.g. "a/path/to/file b/path/to/file"
    const match = headerLine.match(/^[ab]\/(.+?)\s+[ab]\/(.+?)$/);
    const fileName = match ? match[2] : headerLine.split(' ')[1] || 'unknown';

    let status: FileDiff['status'] = 'modified';
    let isHeader = true;
    let additions = 0;
    let deletions = 0;
    const lines: DiffLine[] = [];

    let curOld = 0;
    let curNew = 0;

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];

      if (isHeader) {
        if (line.startsWith('new file mode')) {
          status = 'added';
        } else if (line.startsWith('deleted file mode')) {
          status = 'deleted';
        }

        if (line.startsWith('@@')) {
          isHeader = false;
        } else {
          continue;
        }
      }

      if (line.startsWith('@@')) {
        // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          curOld = parseInt(hunkMatch[1], 10);
          curNew = parseInt(hunkMatch[2], 10);
        }
        lines.push({
          type: 'header',
          content: line,
        });
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
        lines.push({
          type: 'add',
          content: line.slice(1),
          newLineNo: curNew++,
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
        lines.push({
          type: 'del',
          content: line.slice(1),
          oldLineNo: curOld++,
        });
      } else if (line.startsWith(' ') || line === '') {
        lines.push({
          type: 'context',
          content: line.startsWith(' ') ? line.slice(1) : line,
          oldLineNo: curOld++,
          newLineNo: curNew++,
        });
      }
    }

    files.push({
      file: fileName,
      status,
      additions,
      deletions,
      lines,
    });
  }

  return files;
}

/**
 * Fetch git diff and untracked files for the specified directory.
 */
export async function getGitDiff(targetDir?: string): Promise<GitDiffResult> {
  const dir = targetDir && targetDir.trim() ? path.resolve(targetDir) : homedir();

  // 1. Check if git repo
  let repoRoot = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      timeout: 3000,
    });
    repoRoot = stdout.trim();
  } catch {
    return {
      isGit: false,
      repoRoot: '',
      files: [],
      summary: { filesChanged: 0, additions: 0, deletions: 0 },
    };
  }

  // 2. Fetch diff (HEAD includes both staged and unstaged)
  let rawDiff = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'diff', 'HEAD'], {
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    rawDiff = stdout;
  } catch {
    // If no HEAD yet (empty repo), fall back to plain git diff
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'diff'], {
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      });
      rawDiff = stdout;
    } catch {}
  }

  const files = parseUnifiedDiff(rawDiff);

  // 3. Fetch untracked files
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard'],
      { timeout: 3000 },
    );
    const untracked = stdout.trim().split('\n').filter(Boolean);
    const existingFileNames = new Set(files.map((f) => f.file));

    for (const uf of untracked) {
      if (!existingFileNames.has(uf)) {
        files.push({
          file: uf,
          status: 'untracked',
          additions: 0,
          deletions: 0,
          lines: [],
        });
      }
    }
  } catch {}

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    isGit: true,
    repoRoot,
    files,
    summary: {
      filesChanged: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
  };
}
