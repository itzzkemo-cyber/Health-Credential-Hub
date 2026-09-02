export const schedulesEn = {
  cancel_draft: "Cancel draft",
  cancel_title: "Cancel this draft?",
  cancel_hint:
    "This unpublished schedule will leave the active list. Employees can then be scheduled in a new draft with corrected settings. The cancelled schedule and audit history are retained.",
  cancelled: "Cancelled",
  title: "Shift schedules",
  my_title: "My shifts",
  team_title: "Team schedule",
  requests_title: "Shift requests",
  manage_view: "Manage rosters",
  requests_view: "Requests",
  view_label: "Schedule view",
  subtitle:
    "Plan the month, review coverage, and publish a clear schedule for your team.",
  my_subtitle:
    "Your published shifts, kept in one place. Contact your manager about changes.",
  team_subtitle:
    "View the published shifts for you and the coworkers included in your team roster.",
  requests_subtitle:
    "Request leave, a preferred shift, an off day, or EO and follow the supervisor or manager decision.",
  month: "Month",
  new_schedule: "Create schedule",
  back: "Back to schedules",
  title_label: "Schedule title",
  title_placeholder: "Team monthly schedule",
  empty: "No schedules for this month",
  empty_hint: "Create a draft to start planning your team's shifts.",
  my_empty: "No published shifts for this month",
  my_empty_hint:
    "Your schedule will appear here after your manager publishes it.",
  team_empty: "No published team schedule for this month",
  team_empty_hint:
    "Your team schedule will appear here after your manager publishes it.",
  draft: "Draft",
  published: "Published",
  employees: "Employees",
  team_members: "team members",
  you: "You",
  shifts: "Shifts",
  shortages: "Unfilled places",
  selected: "selected",
  select_employees: "Choose employees",
  search_employees: "Search name or employee number",
  no_employees: "No active employees match this search.",
  team_hint:
    "Choose active employees within your access. A schedule belongs to one facility; an employee can appear in only one schedule each month.",
  same_facility: "Select employees from the same facility.",
  select_all: "Select matching employees",
  clear_selection: "Clear selection",
  employee: "Employee",
  employee_fallback: "Employee ID",
  settings: "Shift setup",
  settings_hint:
    "Times use Asia/Riyadh (UTC+3). An end time before the start continues into the next day.",
  code: "Code",
  label: "English name",
  label_ar: "Arabic name",
  start: "Starts",
  end: "Ends",
  required: "Staff / day",
  morning: "Morning",
  afternoon: "Afternoon",
  night: "Night",
  constraints: "Planning limits",
  rest: "Minimum rest (hours)",
  consecutive: "Maximum consecutive workdays",
  max_month: "Maximum shifts per employee / month",
  unavailable: "Unavailable",
  off: "Off",
  availability_title: "Unavailability",
  availability_hint:
    "Block dates that cannot be worked. Do not include medical details or a reason.",
  date_from: "From date",
  date_to: "Through date",
  add_unavailable: "Block dates",
  remove_unavailable: "Remove blocked date",
  none_unavailable: "No dates blocked.",
  choose_employee: "Choose an employee",
  invalid_range: "Choose an employee and valid dates within this month.",
  generate: "Generate & save draft",
  generating: "Building draft…",
  planning_notice:
    "Planning assistance only. Review local staffing requirements, employee suitability and adjacent-month shifts before publishing. This is not a clinical or regulatory approval.",
  boundary_notice:
    "Saved adjacent-month schedules are included in rest and consecutive-day checks. Review any missing or external shifts manually.",
  coverage_notice:
    "Some required places are unfilled. Adjust the draft or create a new plan with suitable staffing and limits before publishing.",
  constraints_notice:
    "Edits are validated by the server for rest, consecutive days, monthly limits and blocked dates when you save.",
  open: "Open schedule",
  edit_day: "Edit one day",
  day: "Day",
  matrix: "Monthly shift grid",
  matrix_hint:
    "Scroll within the grid to view all days. On a phone, edit one day at a time below.",
  team_matrix: "Published team roster",
  team_matrix_hint:
    "Scroll within the read-only grid to view the published shifts for every team member.",
  team_day_view: "Team shifts for one day",
  team_day_hint:
    "Choose a date to see each team member's published shift on your phone.",
  team_visibility_hint:
    "Only people included in this published roster and authorized managers can view these names and shifts.",
  total: "Total",
  coverage: "Daily coverage",
  assigned_required: "assigned / required",
  no_shortages: "All required places covered",
  unfilled: "unfilled",
  assignment: "Shift assignment",
  next_day: "Next day",
  previous_day: "Previous day",
  save: "Save changes",
  saving: "Saving…",
  publish: "Publish schedule",
  publishing: "Publishing…",
  reopen: "Withdraw publication",
  reopen_title: "Withdraw this published schedule?",
  reopen_hint:
    "Employees will no longer see these shifts until you publish the schedule again. The schedule and its audit history are retained.",
  reopen_confirm: "Withdraw to draft",
  saved: "Draft saved",
  published_success: "Schedule published",
  reopened_success: "Publication withdrawn; schedule is now a draft",
  unsaved: "Unsaved changes",
  saved_state: "All changes saved",
  publish_hint:
    "Save changes, then resolve planning issues and all unfilled places before publishing.",
  capacity_title: "The current roster cannot cover this schedule",
  capacity_detail:
    "Coverage requires {required} shifts. {employees} employees at a limit of {limit} can cover only {available}; the monthly limit alone requires at least {minimum} employees.",
  draft_saved_blocked: "Draft saved; publication is still blocked",
  draft_saved_blocked_hint:
    "Your edits are preserved. Resolve the following planning issues before publishing:",
  issue_monthly_shift_limit:
    "At least one employee exceeds the monthly shift limit.",
  issue_minimum_rest:
    "At least one assignment does not leave the required minimum rest.",
  issue_consecutive_day_limit:
    "At least one employee exceeds the consecutive workday limit.",
  issue_employee_unavailable:
    "At least one assignment is on a blocked or unavailable date.",
  issue_overlapping_shifts: "At least one employee has overlapping shifts.",
  issue_duplicate_employee_day:
    "An employee has more than one assignment on the same day.",
  issue_adjacent:
    "Adjacent-month assignments could not be validated safely. Review the neighboring schedules.",
  issue_coverage: "Some required shift places remain unfilled.",
  issue_request_conflict:
    "At least one assignment conflicts with an approved employee request.",
  published_hint:
    "Published schedules are read-only. Withdraw publication before making changes.",
  discard_title: "Discard unsaved changes?",
  discard_hint:
    "Your latest edits have not been saved. Leaving this view discards those edits.",
  discard: "Discard changes",
  conflict:
    "This schedule changed elsewhere. Your edits have been kept on this screen. Reload the latest version before editing again; reloading discards your unsaved changes.",
  reload: "Discard edits & reload latest",
  failed:
    "The schedule could not be saved. Check your connection and try again.",
  invalid:
    "Review employees, shift times, staffing and planning limits. Assignments must respect blocked dates, rest and work limits.",
  overlap:
    "An employee already belongs to a schedule for this month. Update that schedule or choose different employees.",
  forbidden:
    "You no longer have access to this schedule or one of its employees. Contact your administrator.",
  review_required: "Review before publication",
  version: "Version",
  create_error:
    "The draft could not be created. Review the selected employees and settings, then try again.",
  shift_count: "scheduled shifts",
  publish_title: "Publish this schedule?",
  publish_confirmation:
    "The selected employees will be able to see the published team roster, including participant names and shifts. Confirm that coverage, suitability and adjacent-month rest have been reviewed.",
  request_new: "New request",
  request_new_hint:
    "The availability check is advisory. A supervisor or manager reviews every request before it is approved.",
  request_kind: "Request type",
  request_kind_leave: "Leave",
  request_kind_preferred_shift: "Preferred shift",
  request_kind_off: "Off day",
  request_kind_eo: "EO",
  request_kind_eo_hint:
    "EO: a request for a day without a shift, according to your facility policy.",
  request_start_date: "Start date",
  request_end_date: "End date",
  request_date: "Date",
  request_shift_code: "Preferred shift code",
  request_shift_code_placeholder: "For example: M or N",
  request_shift_code_hint:
    "Enter the code used in your published schedule. The manager will confirm whether that shift is available.",
  request_note: "Note (optional)",
  request_note_placeholder: "A short scheduling note",
  request_privacy_hint:
    "Do not include medical information, diagnoses, document details, or other sensitive information.",
  request_submit: "Send request",
  request_submitting: "Sending…",
  request_submitted: "Request sent for review",
  request_my: "My requests",
  request_team: "Team requests",
  request_team_hint:
    "View requests within your authorized team scope and filter the retained history by status.",
  request_empty: "No requests yet",
  request_empty_hint: "Requests you submit will appear here with their status.",
  request_team_empty: "No team requests match this status",
  request_team_empty_hint:
    "Scoped requests will appear here when they match the selected status.",
  request_status: "Status",
  request_status_pending: "Pending review",
  request_status_approved: "Approved",
  request_status_rejected: "Rejected",
  request_status_withdrawn: "Withdrawn",
  request_feasibility: "Availability check",
  request_feasibility_possible: "May be possible",
  request_feasibility_conflict: "Conflict found",
  request_feasibility_unknown: "Needs review",
  request_feasibility_disclaimer:
    "This automated result is planning guidance only and is not an approval. The schedule and staffing requirements can change before a decision.",
  request_reason_schedule_not_found: "No saved schedule covers this date.",
  request_reason_employee_not_in_schedule:
    "You are not included in the saved schedule for this date.",
  request_reason_already_unassigned: "No shift is currently assigned on this date.",
  request_reason_request_preserves_coverage:
    "Current staffing remains at or above the saved requirement.",
  request_reason_coverage_shortage:
    "Removing the assigned shift may leave required coverage unfilled.",
  request_reason_shift_not_configured:
    "The requested shift code is not configured in the saved schedule.",
  request_reason_preferred_shift_unchanged:
    "The requested shift already matches the saved assignment.",
  request_reason_preferred_shift_available:
    "The requested shift currently fits the saved planning limits.",
  request_reason_published_schedule_requires_reopen:
    "An approved request does not change the published roster; a manager must withdraw publication before editing it.",
  request_reason_schedule_constraint_conflict:
    "The change may conflict with saved rest or work limits.",
  request_reason_duplicate_employee_day:
    "The change would create more than one shift on the same day.",
  request_reason_monthly_shift_limit:
    "The change may exceed the saved monthly shift limit.",
  request_reason_minimum_rest:
    "The change may not leave the saved minimum rest time.",
  request_reason_overlapping_shifts:
    "The requested shift may overlap another saved shift.",
  request_reason_consecutive_day_limit:
    "The change may exceed the saved consecutive-workday limit.",
  request_reason_employee_unavailable:
    "The date is recorded as unavailable in the saved schedule.",
  request_reason_invalid_adjacent_assignments:
    "Adjacent-month assignments require a manager review.",
  request_reason_invalid_assignments:
    "The saved assignments require a manager review before this change.",
  request_reason_invalid_assignment:
    "The simulated assignment is not valid for the saved schedule.",
  request_reason_generic: "A supervisor or manager must review this request.",
  request_created: "Submitted",
  request_period: "Requested period",
  request_employee: "Employee",
  request_withdraw: "Withdraw request",
  request_withdraw_title: "Withdraw this request?",
  request_withdraw_hint:
    "The request will remain in your history as withdrawn and can no longer be approved or rejected.",
  request_withdraw_confirm: "Confirm withdrawal",
  request_withdrawing: "Withdrawing…",
  request_withdrawn_success: "Request withdrawn",
  request_approve: "Approve",
  request_reject: "Reject",
  request_revoke_approval: "Revoke approval",
  request_decision_title: "Confirm request decision",
  request_approve_hint:
    "Approve this request after reviewing the employee, requested dates, and current availability result. Approval does not edit a published roster automatically.",
  request_reject_hint:
    "Reject this request after reviewing the employee, requested dates, and current availability result. The decision is retained in history.",
  request_revoke_approval_hint:
    "Revoke this approval only to correct a prior decision. The request will be retained as rejected with an audited decision history.",
  request_deciding: "Saving decision…",
  request_approved_success: "Request approved",
  request_rejected_success: "Request rejected",
  request_revoked_success: "Approval revoked",
  request_validation_required: "Complete the required request fields.",
  request_validation_dates:
    "Choose valid dates in the same month. Leave may cover up to 31 days.",
  request_validation_single_day:
    "This request type must use one date only.",
  request_validation_shift: "Enter the preferred shift code.",
  request_validation_note: "Keep the note to 500 characters or fewer.",
  request_error:
    "The request could not be saved. Check your connection and try again.",
  request_invalid:
    "Review the request type, dates, shift code, and note, then try again.",
  request_forbidden:
    "You no longer have access to this request. Refresh the page or contact your administrator.",
  request_conflict:
    "The request changed elsewhere or conflicts with an approved request. Refresh the latest requests before trying again.",
  request_approved_conflict:
    "Another approved request overlaps these dates. Review the employee's approved request history before deciding again.",
  request_refresh: "Refresh requests",
};

export const schedulesAr: Record<keyof typeof schedulesEn, string> = {
  cancel_draft: "إلغاء المسودة",
  cancel_title: "هل تريد إلغاء هذه المسودة؟",
  cancel_hint:
    "سيُزال الجدول غير المنشور من القائمة النشطة. يمكنك بعدها إدراج الموظفين في مسودة جديدة بإعدادات مصححة. سيُحتفظ بالجدول الملغى وسجل التدقيق.",
  cancelled: "ملغى",
  title: "جداول المناوبات",
  my_title: "مناوباتي",
  team_title: "جدول الفريق",
  requests_title: "طلبات المناوبات",
  manage_view: "إدارة الجداول",
  requests_view: "الطلبات",
  view_label: "عرض الجدول",
  subtitle: "خطط للشهر، وراجع التغطية، وانشر جدولاً واضحاً لفريقك.",
  my_subtitle: "مناوباتك المنشورة في مكان واحد. تواصل مع مديرك لطلب التعديل.",
  team_subtitle:
    "اطّلع على مناوباتك المنشورة ومناوبات الزملاء المدرجين معك في جدول الفريق.",
  requests_subtitle:
    "اطلب إجازة أو مناوبة محددة أو يوم راحة أو EO، وتابع قرار المشرف أو المدير.",
  month: "الشهر",
  new_schedule: "إنشاء جدول",
  back: "العودة للجداول",
  title_label: "عنوان الجدول",
  title_placeholder: "جدول الفريق الشهري",
  empty: "لا توجد جداول لهذا الشهر",
  empty_hint: "أنشئ مسودة لبدء تخطيط مناوبات فريقك.",
  my_empty: "لا توجد مناوبات منشورة لهذا الشهر",
  my_empty_hint: "سيظهر جدولك هنا بعد أن ينشره مديرك.",
  team_empty: "لا يوجد جدول فريق منشور لهذا الشهر",
  team_empty_hint: "سيظهر جدول فريقك هنا بعد أن ينشره مديرك.",
  draft: "مسودة",
  published: "منشور",
  employees: "الموظفون",
  team_members: "أعضاء الفريق",
  you: "أنت",
  shifts: "المناوبات",
  shortages: "أماكن غير مغطاة",
  selected: "محدد",
  select_employees: "اختيار الموظفين",
  search_employees: "البحث بالاسم أو الرقم الوظيفي",
  no_employees: "لا يوجد موظفون نشطون يطابقون البحث.",
  team_hint:
    "اختر الموظفين النشطين ضمن صلاحياتك. يخص كل جدول منشأة واحدة، ولا يمكن إدراج الموظف في أكثر من جدول للشهر نفسه.",
  same_facility: "اختر موظفين من المنشأة نفسها.",
  select_all: "تحديد نتائج البحث",
  clear_selection: "إلغاء التحديد",
  employee: "الموظف",
  employee_fallback: "معرّف الموظف",
  settings: "إعداد المناوبات",
  settings_hint:
    "الأوقات حسب توقيت الرياض (UTC+3). وقت الانتهاء الأسبق من البداية يعني الاستمرار لليوم التالي.",
  code: "الرمز",
  label: "الاسم بالإنجليزية",
  label_ar: "الاسم بالعربية",
  start: "البداية",
  end: "النهاية",
  required: "موظفون / يوم",
  morning: "صباحي",
  afternoon: "مسائي",
  night: "ليلي",
  constraints: "حدود التخطيط",
  rest: "أقل راحة (ساعات)",
  consecutive: "أقصى أيام عمل متتالية",
  max_month: "أقصى مناوبات لكل موظف / شهر",
  unavailable: "غير متاح",
  off: "راحة",
  availability_title: "عدم التوفر",
  availability_hint:
    "احجب التواريخ التي لا يمكن العمل خلالها. لا تذكر تفاصيل طبية أو سبباً.",
  date_from: "من تاريخ",
  date_to: "حتى تاريخ",
  add_unavailable: "حجب التواريخ",
  remove_unavailable: "إزالة تاريخ محجوب",
  none_unavailable: "لا توجد تواريخ محجوبة.",
  choose_employee: "اختر موظفاً",
  invalid_range: "اختر موظفاً وتواريخ صحيحة ضمن الشهر المحدد.",
  generate: "توليد المسودة وحفظها",
  generating: "جارٍ إعداد المسودة…",
  planning_notice:
    "أداة مساعدة للتخطيط فقط. راجع احتياجات التغطية المحلية، وملاءمة الموظفين، ومناوبات الشهرين المجاورين قبل النشر. لا يمثل الجدول اعتماداً سريرياً أو تنظيمياً.",
  boundary_notice:
    "تشمل فحوص الراحة والأيام المتتالية جداول الأشهر المجاورة المحفوظة. راجع يدوياً أي مناوبات خارجية أو غير مسجلة.",
  coverage_notice:
    "توجد أماكن مطلوبة غير مغطاة. عدّل المسودة أو أنشئ خطة جديدة بموظفين وحدود مناسبة قبل النشر.",
  constraints_notice:
    "يتحقق الخادم عند الحفظ من الراحة والأيام المتتالية والحد الشهري والتواريخ المحجوبة.",
  open: "فتح الجدول",
  edit_day: "تعديل يوم واحد",
  day: "اليوم",
  matrix: "شبكة المناوبات الشهرية",
  matrix_hint:
    "مرر داخل الشبكة لعرض جميع الأيام. على الهاتف، عدّل يوماً واحداً في كل مرة أدناه.",
  team_matrix: "جدول الفريق المنشور",
  team_matrix_hint:
    "مرر داخل شبكة القراءة فقط لعرض المناوبات المنشورة لجميع أعضاء الفريق.",
  team_day_view: "مناوبات الفريق ليوم واحد",
  team_day_hint: "اختر تاريخاً لعرض مناوبة كل عضو في الفريق على جوالك.",
  team_visibility_hint:
    "لا يرى هذه الأسماء والمناوبات إلا المدرجون في الجدول المنشور والمدراء المخولون.",
  total: "المجموع",
  coverage: "التغطية اليومية",
  assigned_required: "المعين / المطلوب",
  no_shortages: "جميع الأماكن المطلوبة مغطاة",
  unfilled: "غير مغطى",
  assignment: "تعيين المناوبة",
  next_day: "اليوم التالي",
  previous_day: "اليوم السابق",
  save: "حفظ التغييرات",
  saving: "جارٍ الحفظ…",
  publish: "نشر الجدول",
  publishing: "جارٍ النشر…",
  reopen: "سحب النشر",
  reopen_title: "هل تريد سحب نشر الجدول؟",
  reopen_hint:
    "لن يتمكن الموظفون من رؤية هذه المناوبات حتى تنشر الجدول مجدداً. سيُحتفظ بالجدول وسجل التدقيق.",
  reopen_confirm: "سحب إلى مسودة",
  saved: "تم حفظ المسودة",
  published_success: "تم نشر الجدول",
  reopened_success: "تم سحب النشر وأصبح الجدول مسودة",
  unsaved: "تغييرات غير محفوظة",
  saved_state: "جميع التغييرات محفوظة",
  publish_hint:
    "احفظ التغييرات، ثم عالج مشكلات التخطيط وجميع الأماكن غير المغطاة قبل النشر.",
  capacity_title: "عدد الموظفين الحالي لا يكفي لتغطية الجدول",
  capacity_detail:
    "تحتاج التغطية إلى {required} مناوبة. يستطيع {employees} موظفين بحد {limit} تغطية {available} فقط؛ والحد الشهري وحده يتطلب {minimum} موظفين على الأقل.",
  draft_saved_blocked: "حُفظت المسودة، لكن النشر ما زال متوقفاً",
  draft_saved_blocked_hint:
    "تم الاحتفاظ بتعديلاتك. عالج مشكلات التخطيط التالية قبل النشر:",
  issue_monthly_shift_limit: "تجاوز موظف واحد على الأقل الحد الشهري للمناوبات.",
  issue_minimum_rest:
    "لا تترك إحدى المناوبات على الأقل الحد الأدنى المطلوب للراحة.",
  issue_consecutive_day_limit:
    "تجاوز موظف واحد على الأقل الحد الأقصى لأيام العمل المتتالية.",
  issue_employee_unavailable:
    "توجد مناوبة واحدة على الأقل في تاريخ محجوب أو غير متاح.",
  issue_overlapping_shifts: "توجد مناوبات متداخلة لموظف واحد على الأقل.",
  issue_duplicate_employee_day:
    "لدى أحد الموظفين أكثر من مناوبة في اليوم نفسه.",
  issue_adjacent:
    "تعذر التحقق الآمن من مناوبات الأشهر المجاورة. راجع الجداول المجاورة.",
  issue_coverage: "ما زالت بعض أماكن المناوبات المطلوبة غير مغطاة.",
  issue_request_conflict:
    "تتعارض إحدى المناوبات على الأقل مع طلب موظف معتمد.",
  published_hint: "الجداول المنشورة للقراءة فقط. اسحب النشر قبل التعديل.",
  discard_title: "هل تريد تجاهل التغييرات غير المحفوظة؟",
  discard_hint:
    "لم تُحفظ تعديلاتك الأخيرة. ستفقد هذه التعديلات عند مغادرة العرض.",
  discard: "تجاهل التغييرات",
  conflict:
    "تم تعديل الجدول من جهة أخرى. احتُفظ بتعديلاتك على هذه الشاشة. أعد تحميل أحدث نسخة قبل التعديل مجدداً؛ إعادة التحميل تتجاهل تعديلاتك غير المحفوظة.",
  reload: "تجاهل التعديلات وتحميل الأحدث",
  failed: "تعذر حفظ الجدول. تحقق من الاتصال وحاول مجدداً.",
  invalid:
    "راجع الموظفين وأوقات المناوبات والتغطية وحدود التخطيط. يجب أن تراعي التعيينات التواريخ المحجوبة والراحة وحدود العمل.",
  overlap:
    "أحد الموظفين موجود في جدول لهذا الشهر. عدّل ذلك الجدول أو اختر موظفين آخرين.",
  forbidden:
    "لم تعد تملك صلاحية الوصول إلى هذا الجدول أو أحد موظفيه. تواصل مع المسؤول.",
  review_required: "تجب المراجعة قبل النشر",
  version: "الإصدار",
  create_error:
    "تعذر إنشاء المسودة. راجع الموظفين والإعدادات المختارة وحاول مجدداً.",
  shift_count: "مناوبات مجدولة",
  publish_title: "هل تريد نشر هذا الجدول؟",
  publish_confirmation:
    "سيتمكن الموظفون المختارون من رؤية جدول الفريق المنشور، بما فيه أسماء المشاركين ومناوباتهم. أكد مراجعة التغطية والملاءمة والراحة بين الأشهر.",
  request_new: "طلب جديد",
  request_new_hint:
    "فحص الإمكانية استرشادي، ويراجع المشرف أو المدير كل طلب قبل اعتماده.",
  request_kind: "نوع الطلب",
  request_kind_leave: "إجازة",
  request_kind_preferred_shift: "مناوبة محددة",
  request_kind_off: "يوم راحة",
  request_kind_eo: "EO",
  request_kind_eo_hint: "EO: طلب يوم دون مناوبة وفق سياسة المنشأة.",
  request_start_date: "تاريخ البداية",
  request_end_date: "تاريخ النهاية",
  request_date: "التاريخ",
  request_shift_code: "رمز المناوبة المطلوبة",
  request_shift_code_placeholder: "مثال: M أو N",
  request_shift_code_hint:
    "أدخل الرمز المستخدم في جدولك المنشور، وسيؤكد المدير إمكانية المناوبة.",
  request_note: "ملاحظة (اختيارية)",
  request_note_placeholder: "ملاحظة قصيرة تخص الجدولة",
  request_privacy_hint:
    "لا تكتب معلومات طبية أو تشخيصاً أو تفاصيل وثائق أو أي معلومات حساسة أخرى.",
  request_submit: "إرسال الطلب",
  request_submitting: "جارٍ الإرسال…",
  request_submitted: "أُرسل الطلب للمراجعة",
  request_my: "طلباتي",
  request_team: "طلبات الفريق",
  request_team_hint:
    "اعرض الطلبات ضمن نطاق فريقك المصرح لك به، وصفِّ السجل المحتفظ به حسب الحالة.",
  request_empty: "لا توجد طلبات حتى الآن",
  request_empty_hint: "ستظهر طلباتك هنا مع حالتها بعد إرسالها.",
  request_team_empty: "لا توجد طلبات فريق مطابقة لهذه الحالة",
  request_team_empty_hint:
    "ستظهر هنا الطلبات ضمن نطاقك عندما تطابق الحالة المختارة.",
  request_status: "الحالة",
  request_status_pending: "بانتظار المراجعة",
  request_status_approved: "مقبول",
  request_status_rejected: "مرفوض",
  request_status_withdrawn: "مسحوب",
  request_feasibility: "فحص الإمكانية",
  request_feasibility_possible: "قد يكون ممكناً",
  request_feasibility_conflict: "يوجد تعارض",
  request_feasibility_unknown: "يحتاج مراجعة",
  request_feasibility_disclaimer:
    "هذه النتيجة الآلية إرشاد للتخطيط فقط وليست موافقة. قد يتغير الجدول واحتياج التغطية قبل اتخاذ القرار.",
  request_reason_schedule_not_found: "لا يوجد جدول محفوظ يغطي هذا التاريخ.",
  request_reason_employee_not_in_schedule:
    "أنت غير مدرج في الجدول المحفوظ لهذا التاريخ.",
  request_reason_already_unassigned: "لا توجد مناوبة معينة حالياً في هذا التاريخ.",
  request_reason_request_preserves_coverage:
    "تبقى التغطية الحالية مساوية للاحتياج المحفوظ أو أعلى منه.",
  request_reason_coverage_shortage:
    "قد تؤدي إزالة المناوبة المعينة إلى نقص في التغطية المطلوبة.",
  request_reason_shift_not_configured:
    "رمز المناوبة المطلوبة غير مضاف في الجدول المحفوظ.",
  request_reason_preferred_shift_unchanged:
    "المناوبة المطلوبة مطابقة للتعيين المحفوظ حالياً.",
  request_reason_preferred_shift_available:
    "تتوافق المناوبة المطلوبة حالياً مع حدود التخطيط المحفوظة.",
  request_reason_published_schedule_requires_reopen:
    "لا يغيّر الطلب المقبول الجدول المنشور؛ يجب على المدير سحب النشر قبل تعديله.",
  request_reason_schedule_constraint_conflict:
    "قد يتعارض التغيير مع حدود الراحة أو العمل المحفوظة.",
  request_reason_duplicate_employee_day:
    "سيؤدي التغيير إلى أكثر من مناوبة في اليوم نفسه.",
  request_reason_monthly_shift_limit:
    "قد يتجاوز التغيير حد المناوبات الشهري المحفوظ.",
  request_reason_minimum_rest:
    "قد لا يحقق التغيير الحد الأدنى المحفوظ للراحة.",
  request_reason_overlapping_shifts:
    "قد تتداخل المناوبة المطلوبة مع مناوبة محفوظة أخرى.",
  request_reason_consecutive_day_limit:
    "قد يتجاوز التغيير حد أيام العمل المتتالية المحفوظ.",
  request_reason_employee_unavailable:
    "التاريخ مسجل كغير متاح في الجدول المحفوظ.",
  request_reason_invalid_adjacent_assignments:
    "تحتاج مناوبات الأشهر المجاورة إلى مراجعة المدير.",
  request_reason_invalid_assignments:
    "تحتاج التعيينات المحفوظة إلى مراجعة المدير قبل هذا التغيير.",
  request_reason_invalid_assignment:
    "التعيين المحاكى غير صالح للجدول المحفوظ.",
  request_reason_generic: "يجب أن يراجع المشرف أو المدير هذا الطلب.",
  request_created: "تاريخ الإرسال",
  request_period: "الفترة المطلوبة",
  request_employee: "الموظف",
  request_withdraw: "سحب الطلب",
  request_withdraw_title: "هل تريد سحب هذا الطلب؟",
  request_withdraw_hint:
    "سيبقى الطلب في سجلك بحالة مسحوب، ولن يمكن بعد ذلك قبوله أو رفضه.",
  request_withdraw_confirm: "تأكيد السحب",
  request_withdrawing: "جارٍ السحب…",
  request_withdrawn_success: "تم سحب الطلب",
  request_approve: "موافقة",
  request_reject: "رفض",
  request_revoke_approval: "إلغاء الموافقة",
  request_decision_title: "تأكيد قرار الطلب",
  request_approve_hint:
    "وافق على الطلب بعد مراجعة الموظف والتواريخ المطلوبة ونتيجة الإمكانية الحالية. لا تعدّل الموافقة الجدول المنشور تلقائياً.",
  request_reject_hint:
    "ارفض الطلب بعد مراجعة الموظف والتواريخ المطلوبة ونتيجة الإمكانية الحالية. سيُحتفظ بالقرار في السجل.",
  request_revoke_approval_hint:
    "ألغِ هذه الموافقة فقط لتصحيح قرار سابق. سيُحتفظ بالطلب كمرفوض مع سجل تدقيق للقرار.",
  request_deciding: "جارٍ حفظ القرار…",
  request_approved_success: "تمت الموافقة على الطلب",
  request_rejected_success: "تم رفض الطلب",
  request_revoked_success: "تم إلغاء الموافقة",
  request_validation_required: "أكمل حقول الطلب المطلوبة.",
  request_validation_dates:
    "اختر تواريخ صحيحة ضمن الشهر نفسه. يمكن أن تغطي الإجازة 31 يوماً كحد أقصى.",
  request_validation_single_day:
    "يجب أن يستخدم نوع الطلب هذا تاريخاً واحداً فقط.",
  request_validation_shift: "أدخل رمز المناوبة المطلوبة.",
  request_validation_note: "اجعل الملاحظة 500 حرف أو أقل.",
  request_error: "تعذر حفظ الطلب. تحقق من الاتصال وحاول مجدداً.",
  request_invalid:
    "راجع نوع الطلب والتواريخ ورمز المناوبة والملاحظة، ثم حاول مجدداً.",
  request_forbidden:
    "لم تعد تملك صلاحية الوصول إلى هذا الطلب. حدّث الصفحة أو تواصل مع المسؤول.",
  request_conflict:
    "تغيّر هذا الطلب أو يتعارض مع طلب معتمد. حدّث قائمة الطلبات قبل المحاولة مجدداً.",
  request_approved_conflict:
    "يوجد طلب معتمد آخر يتداخل مع هذه التواريخ. راجع سجل طلبات الموظف المعتمدة قبل اتخاذ القرار مجدداً.",
  request_refresh: "تحديث الطلبات",
};
