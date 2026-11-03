import { useEffect, useRef } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import "./delete-confirmation.css";

interface Props {
  name: string;
  filePath?: string;
  saving: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmation({
  name,
  filePath,
  saving,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const origin = document.activeElement;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => {
        if (origin instanceof HTMLElement && origin.isConnected)
          origin.focus({ preventScroll: true });
      });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="delete-confirmation"
      data-testid="delete-confirmation"
      role="alertdialog"
      aria-labelledby="delete-confirmation-title"
      aria-describedby="delete-confirmation-description"
      aria-busy={busy || saving}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="delete-confirmation-content">
        <h2 id="delete-confirmation-title">
          <Trash2 size={18} aria-hidden="true" />
          {t("删除这条历史记录？")}
        </h2>
        <strong className="delete-confirmation-name">{name}</strong>
        <p id="delete-confirmation-description">
          {filePath
            ? t("关联的 JSON 文件将移到系统废纸篓，同时删除应用历史记录。")
            : t("此记录尚未生成本机文件，只会删除应用历史记录。")}
        </p>
        {filePath && (
          <code className="delete-confirmation-path">{filePath}</code>
        )}
        {saving && <p role="status">{t("正在完成自动保存，请稍候…")}</p>}
        {error && (
          <p className="delete-confirmation-error" role="alert">
            {localizeMessage(error)}
          </p>
        )}
        <div className="delete-confirmation-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button"
            disabled={busy}
            onClick={onCancel}
          >
            {t("取消")}
          </button>
          <button
            type="button"
            className="button delete-confirmation-submit"
            disabled={busy || saving}
            onClick={onConfirm}
          >
            {busy ? (
              <>
                <LoaderCircle size={15} className="spin" />
                {t("正在删除…")}
              </>
            ) : filePath ? (
              t("删除文件")
            ) : (
              t("删除记录")
            )}
          </button>
        </div>
      </div>
    </dialog>
  );
}
