import { Card } from 'heroui-native';
import { TvButton as Button } from './TvButton';

export function EmptyPlaceholder({
  actionLabel,
  description,
  inset = false,
  title,
  onAction,
}: {
  actionLabel?: string;
  description?: string;
  inset?: boolean;
  title: string;
  onAction?: () => void;
}) {
  return (
    <Card className={`${inset ? 'mx-5 ' : ''}items-center border border-dashed border-border p-8`} variant="transparent">
      <Card.Body className="items-center gap-1">
        <Card.Title>{title}</Card.Title>
        {description ? <Card.Description className="text-center">{description}</Card.Description> : null}
      </Card.Body>
      {actionLabel && onAction ? (
        <Card.Footer>
          <Button size="sm" variant="outline" onPress={onAction}>
            <Button.Label>{actionLabel}</Button.Label>
          </Button>
        </Card.Footer>
      ) : null}
    </Card>
  );
}
