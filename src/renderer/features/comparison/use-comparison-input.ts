import { useEffect, useRef, useState } from "react";
import type { FormatOptions, ProcessingResult } from "../../../shared/types";
import type { FormatClient } from "../../services/format-client";

interface InputState {
  source: string;
  text: string;
  revision: number;
  name?: string;
  result?: ProcessingResult;
  error?: string;
  readError?: string;
}

export function useComparisonInput(
  client: FormatClient,
  options: FormatOptions,
  recursiveUnescape: boolean,
) {
  const [input, setInput] = useState<InputState>({
    source: "",
    text: "",
    revision: 0,
  });
  const signature = JSON.stringify([options, recursiveUnescape]);
  const [prepared, setPrepared] = useState("");
  const [loading, setLoading] = useState(false);
  const [composing, updateComposing] = useState(false);
  const generation = useRef(0);
  const imports = useRef(0);

  function change(text: string, name?: string) {
    generation.current++;
    imports.current++;
    setLoading(false);
    setPrepared("");
    setInput((previous) => ({
      source: text,
      text,
      revision: previous.revision + 1,
      name: name ?? previous.name,
    }));
  }

  function beginImport() {
    generation.current++;
    setPrepared("");
    setLoading(true);
    return ++imports.current;
  }

  function finishImport(token: number, text: string, name: string) {
    if (imports.current === token) change(text, name);
  }

  function failImport(token: number, error: string) {
    if (imports.current !== token) return;
    generation.current++;
    setLoading(false);
    setInput((previous) => ({
      ...previous,
      error,
      readError: error,
      result: undefined,
    }));
  }

  useEffect(() => {
    if (!input.source.trim() || input.readError || loading || composing) return;
    const job = ++generation.current;
    const timer = setTimeout(() => {
      void client.format(input.source, options, recursiveUnescape).then(
        (result) => {
          if (generation.current !== job) return;
          setInput((previous) => ({
            ...previous,
            text: result.success ? result.output : previous.source,
            result,
            error: result.error?.message,
          }));
          setPrepared(signature);
        },
        (error: unknown) => {
          if (generation.current !== job) return;
          setInput((previous) => ({
            ...previous,
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          }));
          setPrepared(signature);
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [
    client,
    input.source,
    input.revision,
    input.readError,
    options,
    recursiveUnescape,
    signature,
    loading,
    composing,
  ]);

  const pending =
    loading ||
    composing ||
    (Boolean(input.source.trim()) && prepared !== signature && !input.error);
  return {
    ...input,
    pending,
    valid: !pending && !input.error && Boolean(input.result?.success),
    change,
    loading,
    beginImport,
    finishImport,
    failImport,
    setComposing: (enabled: boolean) => {
      generation.current++;
      updateComposing(enabled);
    },
  };
}
