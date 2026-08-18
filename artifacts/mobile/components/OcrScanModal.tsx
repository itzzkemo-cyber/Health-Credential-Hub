import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, cancelAnimation } from 'react-native-reanimated';
import type { OcrResult } from '@workspace/api-client-react';
import { credentialTypes } from '@/data/credentialTypes';
import { CredentialTypeKey } from '@/data/types';

interface OcrScanModalProps {
  visible: boolean;
  /** True while uploading + AI extraction are in flight. */
  loading: boolean;
  error: string | null;
  result: OcrResult | null;
  onClose: () => void;
  onConfirm: (result: OcrResult) => void;
}

export function OcrScanModal({ visible, loading, error, result, onClose, onConfirm }: OcrScanModalProps) {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const scanLineY = useSharedValue(0);

  useEffect(() => {
    if (visible && loading) {
      scanLineY.value = 0;
      scanLineY.value = withRepeat(
        withTiming(150, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      );
    } else {
      cancelAnimation(scanLineY);
    }
    return () => cancelAnimation(scanLineY);
  }, [visible, loading]);

  const scanStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: scanLineY.value }]
  }));

  const pct = (value: number | undefined | null) =>
    Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100);

  const FieldRow = ({ label, value, conf }: { label: string; value: string | null | undefined; conf: number }) => {
    let barColor = colors.success;
    if (conf < 80) barColor = colors.warning;
    if (conf < 50) barColor = colors.destructive;

    return (
      <View style={[styles.row, { flexDirection: isRTL ? 'row-reverse' : 'row', borderBottomColor: colors.border }]}>
        <View style={{ flex: 1, alignItems: isRTL ? 'flex-end' : 'flex-start' }}>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, marginBottom: 2 }}>{label}</Text>
          <Text style={{ fontSize: 14, color: colors.foreground, fontWeight: '600' }}>{value || '—'}</Text>
        </View>
        <View style={{ alignItems: 'flex-end', width: 60 }}>
          <Text style={{ fontSize: 10, color: colors.mutedForeground, marginBottom: 4 }}>{conf}%</Text>
          <View style={{ width: '100%', height: 4, backgroundColor: colors.muted, borderRadius: 2, overflow: 'hidden' }}>
            <View style={{ width: `${conf}%`, height: '100%', backgroundColor: barColor }} />
          </View>
        </View>
      </View>
    );
  };

  const typeDef = result ? credentialTypes[result.detectedType as CredentialTypeKey] : undefined;
  const typeLabel = result
    ? (typeDef ? (isRTL ? typeDef.nameAr : typeDef.nameEn) : result.detectedType)
    : '';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: colors.card }]}>

          {loading ? (
            <View style={styles.scanContent}>
              <View style={styles.docBox}>
                <Ionicons name="document-text" size={80} color={colors.mutedForeground} />
                <Animated.View style={[styles.scanLine, { backgroundColor: colors.primary }, scanStyle]} />
              </View>
              <Text style={{ fontSize: 18, color: colors.foreground, marginTop: 32, fontWeight: '600' }}>{t('ocr.scanning')}</Text>
            </View>
          ) : error ? (
            <View style={styles.resContent}>
              <View style={{ alignItems: 'center', marginBottom: 24 }}>
                <Ionicons name="alert-circle" size={48} color={colors.destructive} />
                <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.foreground, marginTop: 12, textAlign: 'center' }}>
                  {error}
                </Text>
              </View>
              <Pressable style={[styles.btn, { backgroundColor: colors.muted }]} onPress={onClose}>
                <Text style={{ color: colors.foreground, fontWeight: '600' }}>{t('common.close')}</Text>
              </Pressable>
            </View>
          ) : result ? (
            <View style={styles.resContent}>
              <View style={{ alignItems: 'center', marginBottom: 24 }}>
                <Ionicons name="checkmark-circle" size={48} color={colors.success} />
                <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.foreground, marginTop: 8 }}>{t('ocr.detected')}</Text>
                <View style={{ backgroundColor: colors.primary + '20', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, marginTop: 8 }}>
                  <Text style={{ color: colors.primary, fontWeight: 'bold' }}>{typeLabel}</Text>
                </View>
              </View>

              <View style={[styles.fieldsBox, { borderColor: colors.border }]}>
                <FieldRow label={t('credentials.holder')} value={isRTL ? result.holderNameAr || result.holderName : result.holderName} conf={pct(result.confidence?.name)} />
                <FieldRow label={t('credentials.issuer')} value={isRTL ? result.issuerNameAr || result.issuerName : result.issuerName} conf={pct(result.confidence?.issuer)} />
                <FieldRow label={t('credentials.certNumber')} value={result.certificateNumber} conf={pct(result.confidence?.certNumber)} />
                <FieldRow label={t('credentials.issueDate')} value={result.issueDate} conf={pct(result.confidence?.issueDate)} />
                <FieldRow label={t('credentials.expiryDate')} value={result.expiryDate} conf={pct(result.confidence?.expiryDate)} />
              </View>

              <View style={{ backgroundColor: colors.warning + '15', borderRadius: 10, padding: 10, marginTop: 12, flexDirection: isRTL ? 'row-reverse' : 'row', gap: 8, alignItems: 'center' }}>
                <Ionicons name="information-circle" size={18} color={colors.warning} />
                <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, textAlign: isRTL ? 'right' : 'left' }}>
                  {t('ocr.reviewNotice')}
                </Text>
              </View>

              <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', gap: 12, marginTop: 24 }}>
                <Pressable style={[styles.btn, { flex: 1, backgroundColor: colors.muted }]} onPress={onClose}>
                  <Text style={{ color: colors.foreground, fontWeight: '600' }}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable style={[styles.btn, { flex: 2, backgroundColor: colors.primary }]} onPress={() => onConfirm(result)}>
                  <Text style={{ color: 'white', fontWeight: 'bold' }}>{t('ocr.review')}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 24,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  scanContent: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  docBox: {
    width: 120,
    height: 160,
    borderWidth: 2,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  scanLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    shadowColor: '#0D7377',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },
  resContent: {
    width: '100%',
  },
  fieldsBox: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  row: {
    padding: 12,
    borderBottomWidth: 1,
    alignItems: 'center',
  },
  btn: {
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  }
});
