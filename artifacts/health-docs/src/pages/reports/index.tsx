import { useGetComplianceReport } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Printer, Activity, Users, ChevronDown, ChevronUp, CheckCircle } from "lucide-react";
import { useState } from "react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export default function Reports() {
  const { t, language } = useLanguage();
  const { data: report, isLoading } = useGetComplianceReport();
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>({});

  const toggleDept = (name: string) => {
    setExpandedDepts(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const handlePrint = () => {
    window.print();
  };

  const handleExportCSV = () => {
    if (!report) return;

    const csvCell = (value: string | number) => {
      let text = String(value);
      // Prevent spreadsheet applications from evaluating user-controlled cells.
      if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };

    // Build CSV with BOM for Arabic excel compatibility
    const BOM = "\uFEFF";
    let csv = `${BOM}Department,Employee Name,Employee Number,Compliance Rate,Expired,Expiring,Missing\n`;
    
    report.departments.forEach(dept => {
      dept.employees.forEach(emp => {
        const empName = language === 'en' && emp.name ? emp.name : emp.nameAr;
        csv += [
          dept.departmentName,
          empName,
          emp.employeeNumber,
          `${emp.complianceRate}%`,
          emp.expiredCount,
          emp.expiringCount,
          emp.missingCount,
        ].map(csvCell).join(",") + "\n";
      });
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `compliance_report_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return <div className="p-8 text-center animate-pulse">{t('common.loading')}</div>;
  }

  if (!report) return null;

  return (
    <div className="space-y-8 print:space-y-4 print:bg-white print:text-black">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 print:hidden">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('reports.title')}</h1>
          <p className="text-muted-foreground">{t('reports.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePrint} className="gap-2">
            <Printer className="h-4 w-4" />
            {t('reports.print')}
          </Button>
          <Button onClick={handleExportCSV} className="gap-2">
            <Download className="h-4 w-4" />
            {t('reports.export_csv')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="col-span-1 md:col-span-3 bg-primary text-primary-foreground border-transparent overflow-hidden relative">
          <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(255,255,255,0.1)_50%,transparent_75%,transparent_100%)] bg-[length:250px_250px] opacity-50" />
          <CardContent className="p-8 flex flex-col md:flex-row items-center justify-between relative z-10 gap-6">
            <div className="space-y-2 text-center md:text-start">
              <h2 className="text-xl font-medium opacity-90">{t('reports.overall_compliance')}</h2>
              <div className="text-6xl font-bold tracking-tighter">{report.overallComplianceRate}%</div>
              <div className="text-sm opacity-80">{report.facilityName}</div>
            </div>
            <div className="flex gap-8">
              <div className="space-y-1 text-center">
                <div className="text-3xl font-bold">
                  {report.departments.reduce((sum, d) => sum + d.employeeCount, 0)}
                </div>
                <div className="text-sm opacity-80">{t('common.employees')}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold">{t('reports.department_breakdown')}</h2>
        
        <div className="space-y-4">
          {report.departments.map((dept) => {
            const isExpanded = expandedDepts[dept.departmentName];
            return (
              <Card key={dept.departmentName} className="overflow-hidden border-border/50">
                <div 
                  className="p-4 sm:p-6 flex flex-col sm:flex-row items-center gap-4 cursor-pointer hover:bg-muted/10 transition-colors"
                  onClick={() => toggleDept(dept.departmentName)}
                >
                  <div className="flex-1 w-full flex items-center justify-between sm:justify-start gap-4">
                    <div className="p-3 bg-primary/10 rounded-lg text-primary shrink-0">
                      <Users className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold">
                        {dept.departmentName}
                      </h3>
                      <p className="text-sm text-muted-foreground">{dept.employeeCount} {t('common.employees')}</p>
                    </div>
                  </div>
                  
                  <div className="w-full sm:w-64 flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex justify-between mb-1 text-sm font-medium">
                        <span>{t('stats.compliance_rate')}</span>
                        <span>{dept.complianceRate}%</span>
                      </div>
                      <Progress 
                        value={dept.complianceRate} 
                        className="h-2" 
                        indicatorClassName={dept.complianceRate < 70 ? 'bg-destructive' : dept.complianceRate < 90 ? 'bg-amber-500' : 'bg-emerald-500'}
                      />
                    </div>
                    <Button variant="ghost" size="icon" className="shrink-0 print:hidden">
                      {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t bg-muted/5 p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-transparent hover:bg-transparent">
                          <TableHead>{t('reports.employee_name')}</TableHead>
                          <TableHead>{t('reports.status')}</TableHead>
                          <TableHead>{t('reports.missing_docs')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dept.employees.map((emp) => (
                          <TableRow key={emp.employeeNumber}>
                            <TableCell className="font-medium">
                              <div>{language === 'en' && emp.name ? emp.name : emp.nameAr}</div>
                              <div className="text-xs text-muted-foreground font-mono">{emp.employeeNumber}</div>
                            </TableCell>
                            <TableCell>
                              <span className={cn("font-medium", emp.complianceRate < 100 ? "text-destructive" : "text-emerald-600")}>
                                {emp.complianceRate}%
                              </span>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {emp.missingCount > 0 && (
                                  <Badge variant="outline" className="text-xs bg-red-500/10 text-red-700 border-red-200">
                                    {emp.missingCount} {t('common.missing')}
                                  </Badge>
                                )}
                                {emp.expiredCount > 0 && (
                                  <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-200">
                                    {emp.expiredCount} {t('common.expired')}
                                  </Badge>
                                )}
                                {emp.expiringCount > 0 && (
                                  <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-700 border-blue-200">
                                    {emp.expiringCount} {t('common.expiring_soon')}
                                  </Badge>
                                )}
                                {emp.missingCount === 0 && emp.expiredCount === 0 && emp.expiringCount === 0 && (
                                  <span className="text-emerald-600 text-sm font-medium"><CheckCircle className="h-4 w-4 inline mr-1"/> مكتمل</span>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
