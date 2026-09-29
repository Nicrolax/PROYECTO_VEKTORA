import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';

export default async function Inicio() {
  const user = await getSessionUser();
  redirect(user === null ? '/entrar' : '/panel');
}
