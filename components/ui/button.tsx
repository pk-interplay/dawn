"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        /**
         * Dawn's only call to action: a dark indigo pill with a bone label, per
         * the reference build. There is no saturated CTA colour in this design —
         * `bg-primary` sitting just above the canvas is the intent.
         */
        pill: "rounded-full border border-dawn-btn bg-primary text-dawn-bone hover:bg-accent hover:border-[#3a3080] hover:-translate-y-px hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)]",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        xl: "h-12 rounded-lg px-8 text-base has-[>svg]:px-5",
        icon: "size-9",
        /**
         * The pill sizes are padding-driven rather than fixed-height, matching
         * the reference. They repeat `rounded-full` because cva emits size after
         * variant, so a `rounded-*` set only on the variant would lose the merge.
         */
        "pill-sm": "h-auto gap-2 rounded-full px-4 py-2 text-[13.5px]",
        pill: "h-auto gap-2.5 rounded-full px-[26px] py-3.5 text-[14.5px]",
        "pill-lg": "h-auto gap-2.5 rounded-full px-[30px] py-[15px] text-[15px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
