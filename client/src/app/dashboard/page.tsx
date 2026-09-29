'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { LoadingScreen } from '@/components/UI';

// Legacy route — redirect to the role-appropriate dashboard
export default function Dashboard() {
  const router = useRouter();
  useEffect(() => {
    const user = getUser();
    if (!user) { router.replace('/auth'); return; }
    router.replace(user.role === 'DRIVER' ? '/driver' : '/passenger');
  }, [router]);
  return <LoadingScreen label="Redirecting…" />;
}
