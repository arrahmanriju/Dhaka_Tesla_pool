'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated, getUser } from '@/lib/auth';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    if (isAuthenticated()) {
      const user = getUser();
      router.replace(user?.role === 'DRIVER' ? '/driver' : '/passenger');
    }
  }, [router]);

  return (
    <div className="hero">
      <div className="hero__content animate-in">
        <div className="hero__eyebrow">
          <span>⚡</span>
          Dhaka Electric Pooling
        </div>
        <h1 className="hero__title">
          Smart rides, <span>shared costs</span>,<br />zero emissions.
        </h1>
        <p className="hero__desc">
          The first Tesla pool network in Dhaka. Split fares across passengers going
          the same way — powered by real-time matching across Dhaka's key zones.
        </p>
        <div className="hero__ctas">
          <a href="/auth" className="btn btn--primary btn--lg">
            Get started →
          </a>
          <a href="/auth" className="btn btn--secondary btn--lg">
            Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
