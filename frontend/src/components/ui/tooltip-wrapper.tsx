import type { JSX } from "solid-js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface TooltipWrapperProps {
  label: string;
  children: JSX.Element;
}

export function TooltipWrapper(props: TooltipWrapperProps) {
  return (
    <Tooltip>
      <TooltipTrigger>{props.children}</TooltipTrigger>
      <TooltipContent side="top">{props.label}</TooltipContent>
    </Tooltip>
  );
}
