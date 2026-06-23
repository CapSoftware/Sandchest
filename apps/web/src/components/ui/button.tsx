import * as React from "react";
import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "focusable inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-normal transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        primary: "bg-fg text-ink hover:bg-white",
        accent: "bg-accent text-ink hover:bg-accent-2",
        secondary:
          "border border-line-strong bg-white/[0.02] text-fg hover:bg-white/[0.06]",
        ghost: "text-fg-soft hover:text-fg hover:bg-white/[0.05]",
        outline: "border border-line-strong text-fg hover:bg-white/[0.04]",
      },
      size: {
        sm: "h-8 px-3.5 text-[0.85rem]",
        md: "h-10 px-4.5 text-[0.92rem]",
        lg: "h-11 px-5.5 text-[0.95rem]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

type ButtonBaseProps = VariantProps<typeof buttonVariants> & {
  className?: string;
  children: React.ReactNode;
};

type ButtonAsButton = ButtonBaseProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonBaseProps> & {
    href?: undefined;
  };

type ButtonAsLink = ButtonBaseProps &
  Omit<React.ComponentProps<typeof Link>, keyof ButtonBaseProps> & {
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsLink;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if ("href" in props && props.href !== undefined) {
    return <Link className={classes} {...(props as ButtonAsLink)} />;
  }

  return <button className={classes} {...(props as ButtonAsButton)} />;
}

export { buttonVariants };
