import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { Icon, Label, Badge, NativeTabs } from 'expo-router/unstable-native-tabs';
import { useGetUnreadCount, getGetUnreadCountQueryKey } from '@workspace/api-client-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useThemeContext } from '@/context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function useUnreadBadge() {
  const { currentUser } = useAuth();
  const { data } = useGetUnreadCount({
    query: {
      queryKey: getGetUnreadCountQueryKey(),
      enabled: !!currentUser,
      refetchInterval: 30_000,
    },
  });
  return data?.count ?? 0;
}

function NativeTabLayout() {
  const { t } = useLanguage();
  const { currentUser } = useAuth();
  const unread = useUnreadBadge();

  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <Label>{t('nav.dashboard')}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="credentials">
        <Icon sf={{ default: 'shield', selected: 'shield.fill' }} />
        <Label>{t('nav.credentials')}</Label>
      </NativeTabs.Trigger>
      {currentUser?.role !== 'employee' && (
        <NativeTabs.Trigger name="employees">
          <Icon sf={{ default: 'person.2', selected: 'person.2.fill' }} />
          <Label>{t('nav.employees')}</Label>
        </NativeTabs.Trigger>
      )}
      <NativeTabs.Trigger name="notifications">
        <Icon sf={{ default: 'bell', selected: 'bell.fill' }} />
        <Label>{t('nav.notifications')}</Label>
        {unread > 0 && <Badge>{String(unread)}</Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <Icon sf={{ default: 'line.3.horizontal', selected: 'line.3.horizontal' }} />
        <Label>{t('nav.more')}</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const { isDark } = useThemeContext();
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';
  const { t } = useLanguage();
  const { currentUser } = useAuth();
  const unread = useUnreadBadge();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          paddingBottom: insets.bottom,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.dashboard'),
          tabBarIcon: ({ color }) => (
            <Ionicons name="home" size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="credentials"
        options={{
          title: t('nav.credentials'),
          tabBarIcon: ({ color }) => (
            <Ionicons name="shield-checkmark" size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="employees"
        options={{
          title: t('nav.employees'),
          href: currentUser?.role === 'employee' ? null : '/employees',
          tabBarIcon: ({ color }) => (
            <Ionicons name="people" size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t('nav.notifications'),
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.destructive },
          tabBarIcon: ({ color }) => (
            <Ionicons name="notifications" size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t('nav.more'),
          tabBarIcon: ({ color }) => (
            <Ionicons name="menu" size={24} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
