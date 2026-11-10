// AETHER_SUNAPI — device types (SUNAPI runs on cameras, recorders and access control)
import React from 'react';
import { Video, HardDrive, DoorClosed, Cpu } from 'lucide-react';
import type { DeviceKind } from './api';

export const KINDS: { id: DeviceKind; label: string; plural: string }[] = [
  { id: 'camera', label: 'Camera', plural: 'Cameras' },
  { id: 'recorder', label: 'Recorder', plural: 'Recorders' },
  { id: 'access', label: 'Access control', plural: 'Access control' },
  { id: 'other', label: 'Other', plural: 'Other' },
];
export const kindLabel = (k?: string) => KINDS.find(x => x.id === k)?.label || 'Other';

export const KindIcon: React.FC<{ kind?: string; size?: number; className?: string }> = ({ kind, size = 15, className }) => {
  const I = kind === 'camera' ? Video : kind === 'recorder' ? HardDrive : kind === 'access' ? DoorClosed : Cpu;
  return <I size={size} className={className} aria-label={kindLabel(kind)} />;
};
