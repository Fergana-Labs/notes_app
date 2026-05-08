export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  wait: number,
): T & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;
  const wrapped = ((...args: any[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs!;
      lastArgs = null;
      fn(...a);
    }, wait);
  }) as any;
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      const a = lastArgs!;
      lastArgs = null;
      if (a) fn(...a);
    }
  };
  return wrapped;
}
