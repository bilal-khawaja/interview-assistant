import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square, Globe, BrainCog, ChevronUp, Paperclip, X, FileText } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
} from "@/components/ui/attachment";

const styles = `
  *:focus-visible {
    outline-offset: 0 !important;
    --ring-offset: 0 !important;
  }
  textarea::-webkit-scrollbar {
    width: 6px;
  }
  textarea::-webkit-scrollbar-track {
    background: transparent;
  }
  textarea::-webkit-scrollbar-thumb {
    background-color: #444444;
    border-radius: 3px;
  }
  textarea::-webkit-scrollbar-thumb:hover {
    background-color: #555555;
  }
`;

const styleSheet = document.createElement("style");
styleSheet.innerText = styles;
document.head.appendChild(styleSheet);

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "flex w-full rounded-md border-none bg-transparent px-3 py-2.5 text-base text-gray-100 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 min-h-[44px] resize-none scrollbar-thin scrollbar-thumb-[#444444] scrollbar-track-transparent hover:scrollbar-thumb-[#555555]",
      className
    )}
    ref={ref}
    rows={1}
    {...props}
  />
));
Textarea.displayName = "Textarea";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md border border-[#333333] bg-[#1F2023] px-3 py-1.5 text-sm text-white shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      className
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
}
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    const variantClasses = {
      default: "bg-white hover:bg-white/80 text-black",
      outline: "border border-[#444444] bg-transparent hover:bg-[#3A3A40]",
      ghost: "bg-transparent hover:bg-[#3A3A40]",
    };
    const sizeClasses = {
      default: "h-10 px-4 py-2",
      sm: "h-8 px-3 text-sm",
      lg: "h-12 px-6",
      icon: "h-8 w-8 rounded-full aspect-[1/1]",
    };
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

interface PromptInputContextType {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
}
const PromptInputContext = React.createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
});
function usePromptInput() {
  const context = React.useContext(PromptInputContext);
  if (!context) throw new Error("usePromptInput must be used within a PromptInput");
  return context;
}

interface PromptInputProps {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}
const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    { className, isLoading = false, maxHeight = 240, value, onValueChange, onSubmit, children, disabled = false },
    ref
  ) => {
    const [internalValue, setInternalValue] = React.useState(value || "");
    const handleChange = (newValue: string) => {
      setInternalValue(newValue);
      onValueChange?.(newValue);
    };
    return (
      <TooltipProvider>
        <PromptInputContext.Provider
          value={{
            isLoading,
            value: value ?? internalValue,
            setValue: onValueChange ?? handleChange,
            maxHeight,
            onSubmit,
            disabled,
          }}
        >
          <div
            ref={ref}
            className={cn(
              "rounded-3xl border border-[#444444] bg-[#1F2023] p-2 shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300",
              isLoading && "border-red-500/70",
              className
            )}
          >
            {children}
          </div>
        </PromptInputContext.Provider>
      </TooltipProvider>
    );
  }
);
PromptInput.displayName = "PromptInput";

interface PromptInputTextareaProps {
  disableAutosize?: boolean;
  placeholder?: string;
}
const PromptInputTextarea: React.FC<PromptInputTextareaProps & React.ComponentProps<typeof Textarea>> = ({
  className,
  onKeyDown,
  disableAutosize = false,
  placeholder,
  ...props
}) => {
  const { value, setValue, maxHeight, onSubmit, disabled } = usePromptInput();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (disableAutosize || !textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height =
      typeof maxHeight === "number"
        ? `${Math.min(textareaRef.current.scrollHeight, maxHeight)}px`
        : `min(${textareaRef.current.scrollHeight}px, ${maxHeight})`;
  }, [value, maxHeight, disableAutosize]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit?.();
    }
    onKeyDown?.(e);
  };

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={cn("text-base", className)}
      disabled={disabled}
      placeholder={placeholder}
      {...props}
    />
  );
};

interface PromptInputActionsProps extends React.HTMLAttributes<HTMLDivElement> {}
const PromptInputActions: React.FC<PromptInputActionsProps> = ({ children, className, ...props }) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

interface PromptInputActionProps extends React.ComponentProps<typeof Tooltip> {
  tooltip: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}
const PromptInputAction: React.FC<PromptInputActionProps> = ({
  tooltip,
  children,
  className,
  side = "top",
  ...props
}) => {
  const { disabled } = usePromptInput();
  return (
    <Tooltip {...props}>
      <TooltipTrigger asChild disabled={disabled}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};

const CustomDivider: React.FC = () => (
  <div className="relative h-6 w-[1.5px] mx-1">
    <div
      className="absolute inset-0 bg-gradient-to-t from-transparent via-[#9b87f5]/70 to-transparent rounded-full"
      style={{
        clipPath: "polygon(0% 0%, 100% 0%, 100% 40%, 140% 50%, 100% 60%, 100% 100%, 0% 100%, 0% 60%, -40% 50%, 0% 40%)",
      }}
    />
  </div>
);

const darkDropdownContentClass =
  "z-50 min-w-[8rem] rounded-xl border border-[#333333] bg-[#1F2023] p-1 text-[#D1D5DB] shadow-lg";
const darkDropdownItemClass =
  "relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[#D1D5DB] outline-none transition-colors focus:bg-[#3A3A40] focus:text-[#D1D5DB] data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export interface PromptInputModelOption {
  label: string;
  value: string;
}

const FilePreviewImage: React.FC<{ file: File }> = ({ file }) => {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!url) return null;
  return <img src={url} alt={file.name || "Pasted image"} />;
};

const ExpandedImage: React.FC<{ file: File }> = ({ file }) => {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!url) return null;
  return (
    <img
      src={url}
      alt={file.name || "Pasted image"}
      className="max-h-full max-w-full rounded-lg object-contain"
      onClick={(e) => e.stopPropagation()}
    />
  );
};

export const ACCEPTED_ATTACHMENT_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".xls", ".txt", ".md", "image/*"];
const ACCEPTED_ATTACHMENT_ACCEPT = ACCEPTED_ATTACHMENT_EXTENSIONS.join(",");

interface PromptInputBoxProps {
  onSend?: (message: string, files?: File[]) => void;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  models: PromptInputModelOption[];
  model: string;
  onModelChange: (value: string) => void;
  webSearch: boolean;
  onWebSearchChange: (value: boolean) => void;
  webSearchDisabled?: boolean;
  reasoning: boolean;
  onReasoningChange: (value: boolean) => void;
  reasoningDisabled?: boolean;
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  reasoningEfforts?: string[];
}
export const PromptInputBox = React.forwardRef((props: PromptInputBoxProps, ref: React.Ref<HTMLDivElement>) => {
  const {
    onSend = () => {},
    isLoading = false,
    placeholder = "Type your message here...",
    className,
    models,
    model,
    onModelChange,
    webSearch,
    onWebSearchChange,
    webSearchDisabled = false,
    reasoning,
    onReasoningChange,
    reasoningDisabled = false,
    reasoningEffort,
    onReasoningEffortChange,
    reasoningEfforts = ["minimal", "low", "medium", "high"],
  } = props;
  const [input, setInput] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [expandedImage, setExpandedImage] = React.useState<File | null>(null);
  const promptBoxRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const selectedModel = models.find((m) => m.value === model) ?? models[0];

  const addFiles = (incoming: FileList | File[]) => {
    setFiles((prev) => [...prev, ...Array.from(incoming)]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    if (input.trim() || files.length > 0) {
      onSend(input, files.length > 0 ? files : undefined);
      setInput("");
      setFiles([]);
    }
  };

  const hasContent = input.trim() !== "" || files.length > 0;

  return (
    <PromptInput
      value={input}
      onValueChange={setInput}
      isLoading={isLoading}
      onSubmit={handleSubmit}
      className={cn(
        "w-full bg-[#1F2023] border-[#444444] shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300 ease-in-out",
        isDragging && "border-[#1EAEDB] border-2",
        className
      )}
      disabled={isLoading}
      ref={ref || promptBoxRef}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          const items = Array.from(e.clipboardData?.items ?? []);
          const images = items
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (images.length) addFiles(images);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {files.length > 0 && (
          <AttachmentGroup className="px-1 pb-2">
            {files.map((file, index) => {
              const isImage = file.type.startsWith("image/");
              return (
                <Attachment
                  key={`${file.name}-${index}`}
                  size="sm"
                  orientation={isImage ? "vertical" : "horizontal"}
                  className={cn(
                    !isImage && "border-[#444444] bg-[#2E3033] text-[#D1D5DB]",
                    isImage &&
                      "!w-20 overflow-hidden border-0 bg-transparent p-0 hover:bg-transparent has-[>a,>button]:hover:bg-transparent"
                  )}
                >
                  {isImage && (
                    <AttachmentTrigger
                      aria-label={`Expand ${file.name || "pasted image"}`}
                      onClick={() => setExpandedImage(file)}
                    />
                  )}
                  <AttachmentMedia
                    variant={isImage ? "image" : "icon"}
                    className={cn("bg-[#3A3A40]", isImage && "!size-20 rounded-xl bg-transparent")}
                  >
                    {isImage ? <FilePreviewImage file={file} /> : <FileText />}
                  </AttachmentMedia>
                  {!isImage && (
                    <AttachmentContent>
                      <AttachmentTitle>{file.name}</AttachmentTitle>
                      <AttachmentDescription>{(file.size / 1024).toFixed(0)} KB</AttachmentDescription>
                    </AttachmentContent>
                  )}
                  <AttachmentActions
                    className={cn(
                      isImage &&
                        "absolute top-0 z-20 opacity-0 transition-opacity group-hover/attachment:opacity-100"
                    )}
                  >
                    <AttachmentAction
                      aria-label={`Remove ${file.name || "pasted image"}`}
                      onClick={() => removeFile(index)}
                      className={cn(
                        "text-[#9CA3AF] hover:text-[#D1D5DB]",
                        isImage && "flex h-5 w-5 bg-transparent p-0 shadow-none hover:bg-transparent"
                      )}
                    >
                      <X className={cn(isImage && "h-3 w-3")} />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              );
            })}
          </AttachmentGroup>
        )}

        <PromptInputTextarea
          placeholder={webSearch ? "Search the web..." : reasoning ? "Think deeply..." : placeholder}
          className="text-base"
        />
      </div>

      <PromptInputActions className="flex items-center justify-between gap-2 p-0 pt-2">
        <div className="flex items-center gap-1">
          <PromptInputAction tooltip="Attach files">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="h-8 w-8 rounded-full flex items-center justify-center text-[#9CA3AF] hover:text-[#D1D5DB] hover:bg-[#3A3A40] transition-colors"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </PromptInputAction>

          <CustomDivider />

          <button
            type="button"
            onClick={() => onWebSearchChange(!webSearch)}
            disabled={webSearchDisabled}
            className={cn(
              "rounded-full transition-all flex items-center gap-1 px-2 py-1 border h-8 disabled:opacity-30 disabled:pointer-events-none",
              webSearch
                ? "bg-[#1EAEDB]/15 border-[#1EAEDB] text-[#1EAEDB]"
                : "bg-transparent border-transparent text-[#9CA3AF] hover:text-[#D1D5DB]"
            )}
          >
            <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
              <motion.div
                animate={{ rotate: webSearch ? 360 : 0, scale: webSearch ? 1.1 : 1 }}
                whileHover={{ rotate: webSearch ? 360 : 15, scale: 1.1, transition: { type: "spring", stiffness: 300, damping: 10 } }}
                transition={{ type: "spring", stiffness: 260, damping: 25 }}
              >
                <Globe className={cn("w-4 h-4", webSearch ? "text-[#1EAEDB]" : "text-inherit")} />
              </motion.div>
            </div>
            <AnimatePresence>
              {webSearch && (
                <motion.span
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: "auto", opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="text-xs overflow-hidden whitespace-nowrap text-[#1EAEDB] flex-shrink-0"
                >
                  Search
                </motion.span>
              )}
            </AnimatePresence>
          </button>

          <CustomDivider />

          <div className="flex h-8 items-center gap-1">
            <button
              type="button"
              onClick={() => onReasoningChange(!reasoning)}
              disabled={reasoningDisabled}
              className={cn(
                "h-8 rounded-full transition-all flex items-center gap-1 px-2 py-1 border disabled:opacity-30 disabled:pointer-events-none",
                reasoning
                  ? "bg-[#8B5CF6]/15 border-[#8B5CF6] text-[#8B5CF6]"
                  : "bg-transparent border-transparent text-[#9CA3AF] hover:text-[#D1D5DB]"
              )}
            >
              <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                <motion.div
                  animate={{ rotate: reasoning ? 360 : 0, scale: reasoning ? 1.1 : 1 }}
                  whileHover={{ rotate: reasoning ? 360 : 15, scale: 1.1, transition: { type: "spring", stiffness: 300, damping: 10 } }}
                  transition={{ type: "spring", stiffness: 260, damping: 25 }}
                >
                  <BrainCog className={cn("w-4 h-4", reasoning ? "text-[#8B5CF6]" : "text-inherit")} />
                </motion.div>
              </div>
              <AnimatePresence>
                {reasoning && (
                  <motion.span
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: "auto", opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="text-xs overflow-hidden whitespace-nowrap text-[#8B5CF6] flex-shrink-0"
                  >
                    Think
                  </motion.span>
                )}
              </AnimatePresence>
            </button>

            {reasoning && !reasoningDisabled && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 items-center gap-1 rounded-full bg-[#2E3033] px-2 text-[10px] font-medium capitalize text-[#D1D5DB] transition-colors hover:bg-[#3A3A40]"
                  >
                    {reasoningEffort}
                    <ChevronUp className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className={darkDropdownContentClass}>
                  {reasoningEfforts.map((level) => (
                    <DropdownMenuItem
                      key={level}
                      onClick={() => onReasoningEffortChange(level)}
                      className={cn(darkDropdownItemClass, "capitalize")}
                    >
                      <span className={cn("size-1 shrink-0 rounded-full", level === reasoningEffort ? "bg-white" : "bg-transparent")} />
                      {level}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full bg-[#2E3033] px-3 py-1 text-[11px] font-medium text-[#D1D5DB] transition-colors hover:bg-[#3A3A40]"
              >
                {selectedModel?.label ?? model}
                <ChevronUp className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className={cn(darkDropdownContentClass, "p-0")}>
              <ScrollArea className="h-56 w-40">
                <div className="p-1">
                  {models.map((m) => (
                    <DropdownMenuItem
                      key={m.value}
                      onClick={() => onModelChange(m.value)}
                      className={darkDropdownItemClass}
                    >
                      <span className={cn("size-1 shrink-0 rounded-full", m.value === model ? "bg-white" : "bg-transparent")} />
                      {m.label}
                    </DropdownMenuItem>
                  ))}
                </div>
              </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>

          <PromptInputAction tooltip={isLoading ? "Stop generation" : hasContent ? "Send message" : "Type a message"}>
            <Button
              variant="default"
              size="icon"
              className={cn(
                "h-8 w-8 rounded-full transition-all duration-200",
                hasContent
                  ? "bg-white hover:bg-white/80 text-[#1F2023]"
                  : "bg-transparent hover:bg-gray-600/30 text-[#9CA3AF] hover:text-[#D1D5DB]"
              )}
              onClick={handleSubmit}
              disabled={(isLoading && !hasContent) || !hasContent}
            >
              {isLoading ? (
                <Square className="h-4 w-4 fill-[#1F2023] animate-pulse" />
              ) : (
                <ArrowUp className="h-4 w-4 text-[#1F2023]" />
              )}
            </Button>
          </PromptInputAction>
        </div>
      </PromptInputActions>

      {expandedImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-8"
          onClick={() => setExpandedImage(null)}
        >
          <button
            type="button"
            aria-label="Close preview"
            onClick={() => setExpandedImage(null)}
            className="absolute right-6 top-6 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <X className="h-5 w-5" />
          </button>
          <ExpandedImage file={expandedImage} />
        </div>
      )}
    </PromptInput>
  );
});
PromptInputBox.displayName = "PromptInputBox";
