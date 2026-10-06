/**
 * UserMenu Component
 *
 * The signed-in identity, now in the top bar's right-hand cluster rather than at
 * the foot of the menu: the menu became a drawer that is closed most of the
 * time, and sign-out cannot live behind a hidden panel.
 */

import React, { useCallback } from 'react';
import { useFrontX, useAppDispatch, useAppSelector, clearUser, type HeaderState } from '@gears-frontx/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@gears-frontx/ui-kit/dropdown-menu';
import { Icon } from '@iconify/react';
import { Avatar, AvatarImage, AvatarFallback } from '@gears-frontx/ui-kit/avatar';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';

/** First letters of the first two words of the name, or of the email. */
function initialsOf(user: { displayName?: string; email?: string } | null | undefined): string {
  const name = user?.displayName?.trim() || user?.email || '';
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?'
  );
}

export const UserMenu: React.FC = () => {
  const { auth } = useFrontX();
  const dispatch = useAppDispatch();
  const headerState = useAppSelector((state) => state['layout/header'] as HeaderState | undefined);
  const user = headerState?.user;
  const loading = headerState?.loading ?? false;

  const signOut = useCallback(async () => {
    dispatch(clearUser());
    // RP-initiated logout redirects to the IdP; static-token sessions end
    // locally and the AuthGate flips to the login screen via subscribe().
    const transition = await auth?.logout();
    if (transition?.type === 'redirect') window.location.href = transition.redirectUrl;
  }, [auth, dispatch]);

  if (loading) {
    return <Skeleton className="size-8 rounded-full" />;
  }

  const label = user?.displayName || user?.email || 'User';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar>
          {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt={label} />}
          <AvatarFallback>{initialsOf(user)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-56 rounded-lg">
        {/* Identity is shown, not actionable — a menu item would offer a
            profile screen that does not exist yet. */}
        <div className="px-2 py-1.5">
          <div className="truncate text-body font-medium text-foreground">{label}</div>
          {user?.displayName && user?.email && (
            <div className="truncate text-label text-muted-foreground">{user.email}</div>
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <Icon icon="lucide:log-out" className="size-4 shrink-0" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

UserMenu.displayName = 'UserMenu';
