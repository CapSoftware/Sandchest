/**
 * How MDX elements render in the docs and legal pages. Server components,
 * except the code block's copy button.
 */
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { isDraftLegalLink } from "@/lib/legal";
import { CodeBlock } from "./copy";

/** A heading that links to itself, so any section can be shared. */
function anchored(Tag: "h2" | "h3") {
  return function Heading({ id, children, ...props }: ComponentProps<"h2">) {
    return (
      <Tag id={id} {...props}>
        {id ? (
          <a href={`#${id}`} className="anchor">
            {children}
          </a>
        ) : (
          children
        )}
      </Tag>
    );
  };
}

function Link({ href = "", ...props }: ComponentProps<"a">) {
  // Draft legal pages aren't linked from anywhere (see lib/legal.ts); the words stay.
  if (isDraftLegalLink(href)) return <>{props.children}</>;
  const external = /^https?:\/\//.test(href);
  return <a href={href} {...(external ? { rel: "noreferrer" } : {})} {...props} />;
}

export const mdxComponents: MDXComponents = {
  h2: anchored("h2"),
  h3: anchored("h3"),
  a: Link,
  pre: CodeBlock,
  /** `<Email to={legal.contactEmail} />` in the legal pages. */
  Email: ({ to }: { to: string }) => <a href={`mailto:${to}`}>{to}</a>,
  // Tables scroll sideways on a phone rather than squashing.
  table: (props: ComponentProps<"table">) => (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table">
      <table {...props} />
    </div>
  ),
};
