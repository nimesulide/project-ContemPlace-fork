'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AppBar,
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
} from '@mui/material';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import { createClient } from '@/lib/supabase/client';

const navLinks = [
  { label: 'Dashboard', href: '/app/dashboard' },
  { label: 'Capture', href: '/app/capture' },
  { label: 'Settings', href: '/app/settings' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  function handleMenuOpen(event: React.MouseEvent<HTMLElement>) {
    setAnchorEl(event.currentTarget);
  }

  function handleMenuClose() {
    setAnchorEl(null);
  }

  async function handleLogout() {
    handleMenuClose();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/');
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography
            variant="h6"
            component="a"
            href="/app/dashboard"
            sx={{
              flexGrow: 0,
              mr: 4,
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            ContemPlace
          </Typography>

          <Box sx={{ flexGrow: 1, display: 'flex', gap: 1 }}>
            {navLinks.map((link) => (
              <Button
                key={link.href}
                href={link.href}
                color="inherit"
                size="small"
              >
                {link.label}
              </Button>
            ))}
          </Box>

          <IconButton color="inherit" onClick={handleMenuOpen}>
            <AccountCircleIcon />
          </IconButton>
          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleMenuClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <MenuItem onClick={handleLogout}>Logout</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        {children}
      </Box>
    </Box>
  );
}
