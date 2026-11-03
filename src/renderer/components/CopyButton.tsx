import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import { Check, Copy } from "lucide-react";
import { createCopyFeedback } from "./copy-feedback";
import { useI18n } from "../i18n/i18n";
import "./copy-button.css";

interface Props extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "children"
> {
  onCopy: () => boolean | Promise<boolean>;
  feedbackKey: unknown;
  label?: string;
}

export function CopyButton({
  onCopy,
  feedbackKey,
  label,
  className = "",
  ...props
}: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const feedback = useRef<ReturnType<typeof createCopyFeedback>>(undefined);
  useLayoutEffect(() => {
    setCopied(false);
    const instance = createCopyFeedback(setCopied);
    feedback.current = instance;
    return () => {
      instance.dispose();
      if (feedback.current === instance) feedback.current = undefined;
    };
  }, []);
  useLayoutEffect(() => feedback.current?.reset(), [feedbackKey]);

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      {...props}
      className={`button copy-button ${className}`.trim()}
      data-copied={copied ? "true" : undefined}
      onClick={() => void feedback.current?.copy(onCopy)}
    >
      <Icon className="copy-button-icon" size={15} aria-hidden="true" />
      {label ?? t("复制")}
    </button>
  );
}
