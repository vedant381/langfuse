import { cva, type VariantProps } from "class-variance-authority";
import { type LucideIcon } from "lucide-react";

export const badgeVariants = cva(
  "inline-flex w-fit max-w-full min-w-0 shrink-0 items-center rounded-sm border border-transparent text-xs font-normal",
  {
    variants: {
      color: {
        neutral: "bg-tertiary text-tertiary-foreground",
        red: "bg-light-red text-dark-red",
        yellow: "bg-light-yellow text-dark-yellow",
        blue: "bg-light-blue text-dark-blue",
        violet: "bg-light-violet text-dark-violet",
        teal: "bg-light-teal text-dark-teal",
        green: "bg-light-green text-dark-green",
      },
      size: {
        default: "gap-1 px-2.5 py-0.5",
        sm: "gap-1 px-1 py-0 leading-tight",
      },
    },
    defaultVariants: {
      color: "neutral",
      size: "default",
    },
  },
);

type BadgeProps = VariantProps<typeof badgeVariants> & {
  text: string;
  title?: string;
  trailingIcon?: LucideIcon;
};

export function Badge({
  color,
  size,
  text,
  title,
  trailingIcon: TrailingIcon,
  ...props
}: BadgeProps) {
  return (
    <span className={badgeVariants({ color, size })} {...props}>
      <span className="truncate" title={title ?? text}>
        {text}
      </span>
      {TrailingIcon && <TrailingIcon aria-hidden className="size-3 shrink-0" />}
    </span>
  );
}
