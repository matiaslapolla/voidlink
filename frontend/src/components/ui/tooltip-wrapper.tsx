import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

interface TooltipWrapperProps {
  label: string;
  children: React.ReactNode;
}

export function TooltipWrapper({ label, children }: TooltipWrapperProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="contents" />}>{children}</TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
