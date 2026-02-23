import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Sandchest Docs',
  description: 'Documentation for the Sandchest sandbox platform.',
};

export default function Home() {
  redirect('/docs');
}
