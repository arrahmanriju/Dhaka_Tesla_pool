import { redirect } from 'next/navigation';

/**
 * Root page — immediately redirects to /auth.
 * Once a proper landing page exists, replace this redirect.
 */
export default function RootPage() {
  redirect('/auth');
}
