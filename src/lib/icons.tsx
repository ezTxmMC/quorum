import { Icon as Iconify, addCollection } from '@iconify/react';
import lucide from '@iconify-json/lucide/icons.json';
import type { IconifyJSON } from '@iconify/types';
import type { CSSProperties } from 'react';

// Lucide wird gebündelt – die App funktioniert so auch offline.
addCollection(lucide as IconifyJSON);

export function Icon({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return <Iconify icon={name} width={size} height={size} className={className} style={style} />;
}
