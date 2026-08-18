import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';

export default function IntegrationsScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();

  const items = [
    { id: 'scfhs', name: 'هيئة التخصصات الصحية', nameEn: 'SCFHS', desc: 'مزامنة تلقائية للرخص الطبية', descEn: 'Auto-sync medical licenses', icon: 'medical' },
    { id: 'moh', name: 'وزارة الصحة', nameEn: 'Ministry of Health', desc: 'الربط بنظام موارد', descEn: 'Mawared HR Integration', icon: 'business' },
    { id: 'email', name: 'البريد الإلكتروني', nameEn: 'Email Server', desc: 'إرسال تنبيهات الانتهاء', descEn: 'Send expiry alerts', icon: 'mail' },
    { id: 'sms', name: 'الرسائل النصية', nameEn: 'SMS Gateway', desc: 'تنبيهات هامة للموظفين', descEn: 'Critical alerts via SMS', icon: 'chatbubble' },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20 }}>
      
      <View style={{ alignItems: 'center', marginVertical: 32 }}>
        <Ionicons name="git-network" size={64} color={colors.mutedForeground} />
        <Text style={{ fontSize: 24, fontWeight: 'bold', color: colors.foreground, marginTop: 16 }}>
          {isRTL ? 'التكاملات المستقبلية' : 'Future Integrations'}
        </Text>
        <Text style={{ color: colors.mutedForeground, textAlign: 'center', marginTop: 8 }}>
          {isRTL ? 'نعمل على ربط MedCreds بالأنظمة الرئيسية' : 'We are working on connecting MedCreds to major systems'}
        </Text>
      </View>

      <View style={{ gap: 16 }}>
        {items.map(item => (
          <View key={item.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
            <View style={[styles.iconBox, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons name={item.icon as any} size={28} color={colors.primary} />
            </View>
            <View style={[styles.content, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[styles.name, { color: colors.foreground }]}>{isRTL ? item.name : item.nameEn}</Text>
              <Text style={[styles.desc, { color: colors.mutedForeground }]}>{isRTL ? item.desc : item.descEn}</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: colors.warning + '20' }]}>
              <Text style={[styles.badgeText, { color: colors.warning }]}>{t('more.comingSoon')}</Text>
            </View>
          </View>
        ))}
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    gap: 16,
  },
  iconBox: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  desc: {
    fontSize: 13,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: 'bold',
  }
});
