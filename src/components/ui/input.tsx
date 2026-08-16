import * as React from "react"
import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    ({ className, type, ...props }, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    "flex h-9 w-full rounded-md border border-zinc-800 bg-transparent px-3 py-1 text-sm text-zinc-50 shadow-sm transition-all duration-200",
                    "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-zinc-50",
                    "placeholder:text-zinc-500",
                    "focus-visible:outline-none focus-visible:border-zinc-600 focus-visible:ring-1 focus-visible:ring-zinc-600",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
