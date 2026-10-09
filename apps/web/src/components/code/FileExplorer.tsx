import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { ProjectFileEntry } from '../../api/files';

interface TreeNode {
  name: string;
  path: string; // full path for files, prefix for dirs
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(files: ProjectFileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: childPath, isDir: !isLast, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) =>
        a.isDir === b.isDir
          ? a.name.localeCompare(b.name)
          : a.isDir
            ? -1
            : 1,
      )
      .map((n) => ({ ...n, children: sortNodes(n.children) }));
  return sortNodes(root.children);
}

function fileIcon(path: string) {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(lower))
    return <FileImage className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />;
  if (/\.(json|jsonc)$/.test(lower))
    return <FileJson2 className="h-4 w-4 shrink-0 text-amber-400/70" aria-hidden="true" />;
  if (/\.(md|markdown|txt)$/.test(lower))
    return <FileText className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />;
  if (/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|html|htm|css|scss)$/.test(lower))
    return <FileCode2 className="h-4 w-4 shrink-0 text-cyan-400/70" aria-hidden="true" />;
  return <File className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />;
}

function NodeRow({
  node,
  depth,
  selectedPath,
  openDirs,
  onToggleDir,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  openDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (node.isDir) {
    const open = openDirs.has(node.path);
    return (
      <li role="treeitem" aria-expanded={open}>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-zinc-300 hover:bg-zinc-800"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          aria-label={open ? t('code.collapseFolder', { name: node.name }) : t('code.expandFolder', { name: node.name })}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
          )}
          {open ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <ul role="group" className="m-0 list-none p-0">
            {node.children.map((c) => (
              <NodeRow
                key={c.path}
                node={c}
                depth={depth + 1}
                selectedPath={selectedPath}
                openDirs={openDirs}
                onToggleDir={onToggleDir}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const selected = selectedPath === node.path;
  return (
    <li role="treeitem" aria-selected={selected}>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
          selected
            ? 'bg-cyan-950/60 text-zinc-100 ring-1 ring-cyan-800/40'
            : 'text-zinc-300 hover:bg-zinc-800'
        }`}
        style={{ paddingLeft: `${depth * 12 + 28}px` }}
      >
        {fileIcon(node.path)}
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

export function FileExplorer({
  files,
  selectedPath,
  onSelect,
}: {
  files: ProjectFileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildTree(files), [files]);

  const toggleDir = (path: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const q = filter.trim().toLowerCase();
  const visible: TreeNode[] = useMemo(() => {
    if (!q) return tree;
    const flat: TreeNode[] = [];
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (!n.isDir && n.path.toLowerCase().includes(q)) flat.push(n);
        collect(n.children);
      }
    };
    collect(tree);
    return flat;
  }, [tree, q]);

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="shrink-0 p-2">
        <label htmlFor="file-search" className="sr-only">
          {t('code.searchFiles')}
        </label>
        <input
          id="file-search"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('code.searchFiles')}
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600"
        />
      </div>
      <ul role="tree" aria-label={t('code.fileExplorer')} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
        {visible.map((n) => (
          <NodeRow
            key={n.path}
            node={n}
            depth={0}
            selectedPath={selectedPath}
            openDirs={q ? new Set(n.isDir ? [n.path] : []) : openDirs}
            onToggleDir={toggleDir}
            onSelect={onSelect}
          />
        ))}
        {visible.length === 0 && (
          <li className="px-3 py-4 text-xs text-zinc-600">{t('code.noFilesMatch')}</li>
        )}
      </ul>
    </div>
  );
}
