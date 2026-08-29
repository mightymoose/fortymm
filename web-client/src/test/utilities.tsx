import {
  render,
  renderHook,
  screen,
  within,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";

/**
 * A query scope: the whole `screen`, or a `within(node)` subtree. Page objects
 * that bind accessors to a container share this instead of re-deriving it.
 */
export type Container = typeof screen & ReturnType<typeof within>;

/**
 * Catches whatever a `throwOnError` predicate throws during render, so a test
 * can assert on the boundary instead of an uncaught render throw. Shared by
 * every `throwOnError` regression pair (#843, #1468) — construct with a fresh
 * `QueryClient` you control directly (seed cache data, force a background
 * refetch, force a rerender) rather than the auto-wrapped `render` below.
 */
export class RenderBoundary extends Component<
  { children: ReactNode },
  { caught: boolean }
> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render() {
    return this.state.caught ? <div>BOUNDARY</div> : this.props.children;
  }
}

/** A fresh, retry-free QueryClient wrapper — one client per render call. */
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function customRender(
  ui: Parameters<typeof render>[0],
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: createWrapper(), ...options });
}

function customRenderHook<Result, Props>(
  callback: (initialProps: Props) => Result,
  options?: Omit<RenderHookOptions<Props>, "wrapper">,
) {
  return renderHook(callback, { wrapper: createWrapper(), ...options });
}

export * from "@testing-library/react"; // re-export everything
export { customRender as render, customRenderHook as renderHook }; // override with wrapped variants
