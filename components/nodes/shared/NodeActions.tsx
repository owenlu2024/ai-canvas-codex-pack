"use client";

import { Copy, Download, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

interface NodeActionsProps {
  canCopyPrompt: boolean;
  canDownloadImage: boolean;
  copiedPrompt: boolean;
  canEdit: boolean;
  hasContent: boolean;
  onClear: () => void;
  onCopyPrompt: () => void;
  onDownloadImage: () => void;
  onEdit: () => void;
  showEdit: boolean;
  showCopyPrompt: boolean;
  showDownloadImage: boolean;
  downloadLabel?: string;
}

export function NodeActions({
  canCopyPrompt,
  canDownloadImage,
  canEdit,
  copiedPrompt,
  hasContent,
  onClear,
  onCopyPrompt,
  onDownloadImage,
  onEdit,
  showEdit,
  showCopyPrompt,
  showDownloadImage,
  downloadLabel = "下载图片"
}: NodeActionsProps) {
  return (
    <div className="nodrag ml-2 flex h-[30px] items-center gap-1">
      {showEdit ? (
        <IconActionButton
          disabled={!canEdit}
          label="编辑"
          onClick={onEdit}
          title="编辑"
        >
          <Pencil size={17} strokeWidth={1.9} />
        </IconActionButton>
      ) : null}
      {showDownloadImage ? (
        <IconActionButton
          disabled={!canDownloadImage}
          label={downloadLabel}
          onClick={onDownloadImage}
          title={downloadLabel}
        >
          <Download size={17} strokeWidth={1.9} />
        </IconActionButton>
      ) : null}
      {showCopyPrompt ? (
        <IconActionButton
          disabled={!canCopyPrompt}
          label="复制提示词"
          onClick={onCopyPrompt}
          title={copiedPrompt ? "已复制" : "复制提示词"}
        >
          <Copy size={17} strokeWidth={1.85} />
        </IconActionButton>
      ) : null}
      <IconActionButton disabled={!hasContent} label="清空内容" onClick={onClear} title="清空内容">
        <Trash2 size={17} strokeWidth={1.8} />
      </IconActionButton>
    </div>
  );
}

function IconActionButton({
  children,
  disabled,
  label,
  onClick,
  title
}: {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      aria-label={label}
      className={`apple-pressable nodrag grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-[9px] ${
        disabled ? "text-[#AEAEB2]" : "text-primary hover:bg-[var(--surface-control)]"
      }`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
