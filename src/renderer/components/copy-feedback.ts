interface Timing {
  duration?: number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}

export function createCopyFeedback(
  onChange: (copied: boolean) => void,
  {
    duration = 2_000,
    schedule = setTimeout,
    cancel = clearTimeout,
  }: Timing = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context = 0;
  let sequence = 0;
  let latestSuccess = 0;
  let disposed = false;
  let copied = false;

  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const publish = (value: boolean) => {
    if (copied === value) return;
    copied = value;
    onChange(value);
  };

  return {
    async copy(action: () => boolean | Promise<boolean>) {
      const origin = context;
      const attempt = ++sequence;
      let success = false;
      try {
        success = (await action()) === true;
      } catch {}
      if (disposed || origin !== context) return success;
      if (success) {
        latestSuccess = Math.max(latestSuccess, attempt);
        clear();
        publish(true);
        timer = schedule(() => {
          timer = undefined;
          publish(false);
        }, duration);
      } else if (attempt >= latestSuccess) {
        clear();
        publish(false);
      }
      return success;
    },
    reset() {
      context++;
      latestSuccess = 0;
      clear();
      publish(false);
    },
    dispose() {
      disposed = true;
      context++;
      clear();
    },
  };
}
