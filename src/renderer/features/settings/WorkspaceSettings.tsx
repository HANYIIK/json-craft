import { useId } from "react";
import {
  ArrowLeft,
  Check,
  FolderOpen,
  LoaderCircle,
  Languages,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import type { DirectoryKind, WorkspaceSettings } from "../../../shared/types";
import { Select } from "../../components/Select";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import "./workspace-settings.css";

interface Props {
  settings: WorkspaceSettings;
  busy: boolean;
  error?: string;
  onChange: (patch: Partial<WorkspaceSettings>) => void;
  onBrowse: (kind: DirectoryKind) => void;
  onClose: () => void;
  onRestore?: () => void;
}

const directories: {
  key: keyof Pick<
    WorkspaceSettings,
    "readDirectory" | "writeDirectory" | "historyDirectory"
  >;
  kind: DirectoryKind;
  label: string;
  browseLabel: string;
  description: string;
}[] = [
  {
    key: "readDirectory",
    kind: "read",
    label: "默认读取目录",
    browseLabel: "选择读取目录",
    description: "导入 JSON 文件时优先打开此目录。",
  },
  {
    key: "writeDirectory",
    kind: "write",
    label: "文件存储目录",
    browseLabel: "选择文件存储目录",
    description:
      "原始输入及后续修改自动保存为这里的 .json 文件，拖入文件也保存至此。更改目录后，新输入使用新目录，已保存文件保留原位置。导出时优先使用此目录。",
  },
  {
    key: "historyDirectory",
    kind: "history",
    label: "历史存储目录",
    browseLabel: "选择历史存储目录",
    description:
      "保存用于恢复工作区的内部历史数据，包含原始内容、格式化选项和提取状态，与普通 .json 文件分开管理。应用会自动维护，更改目录会迁移已有历史。",
  },
];

export function WorkspaceSettingsPanel({
  settings,
  busy,
  error,
  onChange,
  onBrowse,
  onClose,
  onRestore,
}: Props) {
  const { t } = useI18n();
  const id = useId();
  const directoryField = (directory: (typeof directories)[number]) => (
    <div className="workspace-settings-field" key={directory.key}>
      <label htmlFor={`${id}-${directory.key}`}>{t(directory.label)}</label>
      <div className="workspace-settings-input-row">
        <input
          id={`${id}-${directory.key}`}
          aria-label={t(directory.label)}
          aria-describedby={`${id}-${directory.key}-description`}
          value={settings[directory.key]}
          placeholder={t("输入完整目录路径")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) =>
            onChange({ [directory.key]: event.target.value })
          }
        />
        <button
          type="button"
          className="button"
          aria-label={t(directory.browseLabel)}
          title={t(directory.browseLabel)}
          onClick={() => onBrowse(directory.kind)}
          disabled={busy}
        >
          <FolderOpen size={14} />
          {t("选择目录")}
        </button>
      </div>
      <p id={`${id}-${directory.key}-description`}>
        {t(directory.description)}
      </p>
    </div>
  );

  return (
    <section className="workspace-settings" aria-label={t("应用设置")}>
      <div className="workspace-settings-content">
        <header className="workspace-settings-header">
          <div className="workspace-settings-navigation">
            <button
              type="button"
              className="button ghost workspace-settings-back"
              onClick={onClose}
              aria-label={t("关闭应用设置")}
              title={t("返回工作区")}
            >
              <ArrowLeft size={15} />
              {t("返回工作区")}
            </button>
            <span
              className={`workspace-settings-status ${error ? "workspace-settings-status-error" : ""}`}
              role="status"
              aria-live="polite"
            >
              {busy ? (
                <LoaderCircle size={13} className="spin" />
              ) : error ? null : (
                <Check size={13} />
              )}
              {t(busy ? "正在保存" : error ? "尚未保存" : "已自动保存")}
            </span>
          </div>
          <h1>{t("应用设置")}</h1>
          <p>{t("调整外观与文件位置，更改后自动保存。")}</p>
        </header>
        {error && (
          <div className="workspace-settings-error" role="alert">
            <span>{localizeMessage(error)}</span>
            {onRestore && (
              <button
                type="button"
                className="button ghost"
                onClick={onRestore}
                disabled={busy}
              >
                {t("恢复已保存设置")}
              </button>
            )}
          </div>
        )}
        <section
          className="workspace-settings-section"
          aria-labelledby={`${id}-appearance-heading`}
        >
          <div className="workspace-settings-section-title">
            <h2 id={`${id}-appearance-heading`}>{t("外观")}</h2>
            <p>{t("设置界面主题与语言。")}</p>
          </div>
          <div className="workspace-settings-fields">
            <div className="workspace-settings-field workspace-settings-theme">
              <label htmlFor={`${id}-theme`}>{t("外观主题")}</label>
              <Select
                id={`${id}-theme`}
                label={t("外观主题")}
                value={settings.theme}
                onChange={(theme) => {
                  if (
                    theme === "system" ||
                    theme === "light" ||
                    theme === "dark"
                  )
                    onChange({ theme });
                }}
                options={[
                  {
                    value: "system",
                    label: t("跟随系统"),
                    icon: <Monitor size={15} />,
                  },
                  { value: "light", label: t("浅色"), icon: <Sun size={15} /> },
                  { value: "dark", label: t("深色"), icon: <Moon size={15} /> },
                ]}
              />
              <p>{t("默认跟随系统，切换后立即生效。")}</p>
            </div>
            <div className="workspace-settings-field workspace-settings-theme">
              <label htmlFor={`${id}-language`}>{t("界面语言")}</label>
              <Select
                id={`${id}-language`}
                label={t("界面语言")}
                value={settings.language ?? "system"}
                onChange={(language) => {
                  if (
                    language === "system" ||
                    language === "zh-CN" ||
                    language === "en"
                  )
                    onChange({ language });
                }}
                options={[
                  {
                    value: "system",
                    label: t("跟随系统"),
                    icon: <Monitor size={15} />,
                  },
                  {
                    value: "zh-CN",
                    label: "简体中文",
                    icon: <Languages size={15} />,
                  },
                  {
                    value: "en",
                    label: "English",
                    icon: <Languages size={15} />,
                  },
                ]}
              />
              <p>{t("默认使用系统语言，切换后立即生效。")}</p>
            </div>
          </div>
        </section>
        <section
          className="workspace-settings-section"
          aria-labelledby={`${id}-storage-heading`}
        >
          <div className="workspace-settings-section-title">
            <h2 id={`${id}-storage-heading`}>{t("文件与存储")}</h2>
            <p>{t("管理 JSON 文件和应用历史的位置。")}</p>
          </div>
          <div className="workspace-settings-fields">
            {directories.slice(0, 2).map(directoryField)}
            <div className="workspace-settings-history">
              <h3>{t("应用历史数据")}</h3>
              {directoryField(directories[2])}
            </div>
          </div>
        </section>
        <p className="workspace-settings-note">
          {t("目录不存在时会自动创建；设置会在下次启动时恢复，无需手动保存。")}
        </p>
      </div>
    </section>
  );
}
