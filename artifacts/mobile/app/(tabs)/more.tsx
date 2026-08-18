import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { showMessage, confirmDialog } from '@/lib/dialogs';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ScreenHeader } from '@/components/ScreenHeader';
import { router } from 'expo-router';

export default function MoreScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const { currentUser, logout } = useAuth();

  if (!currentUser) return null;

  const name = isRTL ? currentUser.nameAr : currentUser.name;
  const roleName =
    (isRTL ? currentUser.jobTitleAr : currentUser.jobTitle) ||
    t(`auth.roles.${currentUser.role}`);

  const handleLogout = async () => {
    const ok = await confirmDialog({
      title: t('common.confirm'),
      message: t('more.signOut'),
      confirmText: t('common.yes'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    await logout();
    router.replace('/(auth)/login');
  };

  const menuItems = [
    { icon: 'settings', label: t('more.settings'), route: '/settings' },
    { icon: 'git-network', label: t('more.integrations'), route: '/integrations' },
    { icon: 'download', label: t('more.export'), action: () => showMessage(t('more.comingSoon')) },
    { icon: 'information-circle', label: t('more.about'), action: () => showMessage('MedCreds', 'v1.0.0\n© 2026') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={t('nav.more')} />
      
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.profileCard, { backgroundColor: colors.primary, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
          <View style={[styles.avatar, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
            <Text style={styles.avatarText}>{name.substring(0,2).toUpperCase()}</Text>
          </View>
          <View style={[styles.profileInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
            <Text style={styles.profileName}>{name}</Text>
            <Text style={styles.profileRole}>{roleName}</Text>
          </View>
        </View>

        <View style={[styles.menuGroup, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {menuItems.map((item, index) => (
            <React.Fragment key={index}>
              <Pressable 
                style={[styles.menuItem, { flexDirection: isRTL ? 'row-reverse' : 'row' }]}
                onPress={() => item.route ? router.push(item.route as any) : item.action?.()}
              >
                <View style={[styles.menuIcon, { backgroundColor: colors.muted }]}>
                  <Ionicons name={item.icon as any} size={20} color={colors.foreground} />
                </View>
                <Text style={[styles.menuLabel, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>
                  {item.label}
                </Text>
                <Ionicons name={isRTL ? 'chevron-back' : 'chevron-forward'} size={20} color={colors.mutedForeground} />
              </Pressable>
              {index < menuItems.length - 1 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
            </React.Fragment>
          ))}
        </View>

        <Pressable 
          style={[styles.logoutBtn, { backgroundColor: colors.destructive + '15', flexDirection: isRTL ? 'row-reverse' : 'row' }]}
          onPress={handleLogout}
        >
          <Ionicons name="log-out" size={24} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>{t('more.signOut')}</Text>
        </Pressable>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 20,
    paddingBottom: 120,
    gap: 24,
  },
  profileCard: {
    padding: 20,
    borderRadius: 16,
    alignItems: 'center',
    gap: 16,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: 'white',
    fontSize: 24,
    fontWeight: 'bold',
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  profileRole: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
  },
  menuGroup: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  menuItem: {
    padding: 16,
    alignItems: 'center',
    gap: 16,
  },
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },
  logoutBtn: {
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: 'bold',
  }
});
