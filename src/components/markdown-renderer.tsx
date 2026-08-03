import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { StreamingCodeBlock } from '@/components/streaming-code-block';
import { cn } from '@/lib/utils';

export function MarkdownRenderer({
    content,
    isStreaming,
    className,
}: {
    content: string;
    isStreaming?: boolean;
    className?: string;
}) {
    const fenceCount = (content.match(/```/g) ?? []).length;
    const skipHighlight = Boolean(isStreaming) && fenceCount % 2 !== 0;

    const components = useMemo(
        () => ({
            pre: (props: React.ComponentProps<'pre'>) => (
                <StreamingCodeBlock {...props} skipHighlight={skipHighlight} />
            ),
            code: ({ className, children, ...props }: React.ComponentProps<'code'>) => {
                const isBlock = /language-/.test(className ?? '');
                if (!isBlock) {
                    return (
                        <code className="inline-code" {...props}>
                            {children}
                        </code>
                    );
                }
                return (
                    <code className={className} {...props}>
                        {children}
                    </code>
                );
            },
        }),
        [skipHighlight],
    );

    return (
        <div className={cn('prose-basic', className)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {content}
            </ReactMarkdown>
        </div>
    );
}
