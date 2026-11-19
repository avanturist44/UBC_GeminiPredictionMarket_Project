import type { Metadata } from 'next';
import { ThesisEditor } from '@/components/thesis-editor';
export const metadata: Metadata = { title: 'Write a thesis' };
export default function WritePage() { return <ThesisEditor />; }
