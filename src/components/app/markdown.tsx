import { openUrl } from "@tauri-apps/plugin-opener"
import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

const components: Components = {
  p: ({ children }) => <p className="my-0 [&:not(:first-child)]:mt-3">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (href) void openUrl(href)
      }}
      className="text-text decoration-text-3 hover:decoration-amber underline underline-offset-2"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mt-3 first:mt-0 flex list-disc flex-col gap-1 pl-5 marker:text-text-3">{children}</ul>,
  ol: ({ children }) => <ol className="mt-3 first:mt-0 flex list-decimal flex-col gap-1 pl-5 marker:text-text-3">{children}</ol>,
  h1: ({ children }) => <h3 className="text-text mt-5 mb-2 text-title font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="text-text mt-5 mb-2 text-title font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="text-text mt-4 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>,
  strong: ({ children }) => <strong className="text-text font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="border-line text-text-2 mt-3 border-l-2 pl-3 first:mt-0">{children}</blockquote>
  ),
  code: ({ className, children }) =>
    className?.startsWith("language-") ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="bg-white/6 text-text rounded-[5px] px-1.5 py-0.5 text-xs">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="bg-panel text-text-2 mt-3 overflow-x-auto rounded-xl p-3.5 font-mono text-code leading-[1.65] shadow-hairline first:mt-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mt-3 overflow-x-auto first:mt-0">
      <table className="w-full border-collapse text-ui">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-line text-text-2 border-b px-2 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-line border-b px-2 py-1.5">{children}</td>,
  hr: () => <hr className="border-line my-4" />,
}

export const Markdown = memo(({ text }: { text: string }) => (
  <div className="selectable text-text text-sm leading-[23px]">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  </div>
))
