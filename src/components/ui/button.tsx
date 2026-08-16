import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default:
                    "bg-zinc-900 text-zinc-50 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700",
                destructive:
                    "bg-red-900/50 text-red-200 border border-red-800/50 hover:bg-red-900/70",
                outline:
                    "border border-zinc-800 bg-transparent hover:bg-zinc-900/50 hover:text-zinc-50",
                secondary:
                    "bg-zinc-800 text-zinc-50 hover:bg-zinc-700",
                ghost:
                    "hover:bg-zinc-800/50 hover:text-zinc-50",
                link:
                    "text-primary underline-offset-4 hover:underline",
                // AI Button - Electric Indigo glow
                ai: "bg-zinc-900 text-zinc-50 border border-indigo-500/50 hover:border-indigo-500 hover:shadow-[0_0_15px_rgba(99,102,241,0.3)] transition-all",
                // Primary action button
                primary:
                    "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white hover:from-indigo-500 hover:to-indigo-400 shadow-lg hover:shadow-indigo-500/25",
            },
            size: {
                default: "h-9 px-4 py-2",
                sm: "h-8 rounded-md px-3 text-xs",
                lg: "h-10 rounded-md px-6",
                xl: "h-12 rounded-lg px-8 text-base",
                icon: "h-9 w-9",
                "icon-sm": "h-8 w-8",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button"
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        )
    }
)
Button.displayName = "Button"

export { Button, buttonVariants }
