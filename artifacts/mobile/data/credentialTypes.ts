import { CredentialTypeKey } from './types';

export interface CredentialTypeDefinition {
  key: CredentialTypeKey;
  nameEn: string;
  nameAr: string;
  icon: string;
  category: 'clinical' | 'admin' | 'safety' | 'legal';
}

/** Registry of all credential types supported by the HealthDocs platform. */
export const credentialTypes: Record<CredentialTypeKey, CredentialTypeDefinition> = {
  BLS: { key: 'BLS', nameEn: 'Basic Life Support', nameAr: 'دعم الحياة الأساسي', icon: 'heart-half', category: 'clinical' },
  ACLS: { key: 'ACLS', nameEn: 'Advanced Cardiac Life Support', nameAr: 'دعم الحياة القلبي المتقدم', icon: 'heart', category: 'clinical' },
  PALS: { key: 'PALS', nameEn: 'Pediatric Advanced Life Support', nameAr: 'دعم الحياة المتقدم للأطفال', icon: 'body', category: 'clinical' },
  NRP: { key: 'NRP', nameEn: 'Neonatal Resuscitation Program', nameAr: 'برنامج إنعاش حديثي الولادة', icon: 'medkit', category: 'clinical' },
  TNCC: { key: 'TNCC', nameEn: 'Trauma Nursing Core Course', nameAr: 'الدورة الأساسية لتمريض الإصابات', icon: 'bandage', category: 'clinical' },
  TCRN: { key: 'TCRN', nameEn: 'Trauma Certified Registered Nurse', nameAr: 'ممرض معتمد في الإصابات', icon: 'medical', category: 'clinical' },
  code_red: { key: 'code_red', nameEn: 'Code Red Training', nameAr: 'تدريب الكود الأحمر', icon: 'flame', category: 'safety' },
  code_blue: { key: 'code_blue', nameEn: 'Code Blue Training', nameAr: 'تدريب الكود الأزرق', icon: 'pulse', category: 'safety' },
  fire_safety: { key: 'fire_safety', nameEn: 'Fire Safety', nameAr: 'السلامة من الحرائق', icon: 'bonfire', category: 'safety' },
  infection_control: { key: 'infection_control', nameEn: 'Infection Control', nameAr: 'مكافحة العدوى', icon: 'shield-checkmark', category: 'safety' },
  SCFHS_license: { key: 'SCFHS_license', nameEn: 'SCFHS License', nameAr: 'رخصة الهيئة السعودية للتخصصات الصحية', icon: 'card', category: 'clinical' },
  SCFHS_classification: { key: 'SCFHS_classification', nameEn: 'SCFHS Classification', nameAr: 'تصنيف الهيئة السعودية للتخصصات الصحية', icon: 'ribbon', category: 'clinical' },
  malpractice_insurance: { key: 'malpractice_insurance', nameEn: 'Malpractice Insurance', nameAr: 'تأمين الأخطاء الطبية', icon: 'umbrella', category: 'legal' },
  employment_id: { key: 'employment_id', nameEn: 'Employment ID', nameAr: 'بطاقة العمل', icon: 'id-card', category: 'admin' },
  passport: { key: 'passport', nameEn: 'Passport', nameAr: 'جواز السفر', icon: 'airplane', category: 'admin' },
  iqama: { key: 'iqama', nameEn: 'Iqama (Residency)', nameAr: 'الإقامة', icon: 'document-text', category: 'admin' },
  visa: { key: 'visa', nameEn: 'Visa', nameAr: 'التأشيرة', icon: 'globe', category: 'admin' },
  driving_license: { key: 'driving_license', nameEn: 'Driving License', nameAr: 'رخصة القيادة', icon: 'car', category: 'admin' },
  medical_license: { key: 'medical_license', nameEn: 'Medical License', nameAr: 'الرخصة الطبية', icon: 'medal', category: 'clinical' },
  custom: { key: 'custom', nameEn: 'Custom Document', nameAr: 'وثيقة مخصصة', icon: 'document', category: 'admin' },
};
