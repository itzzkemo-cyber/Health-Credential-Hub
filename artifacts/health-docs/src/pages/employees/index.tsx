import { useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { useListEmployees } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Search, Filter, AlertCircle, HeartPulse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";

export default function EmployeesList() {
  const { t, isRTL } = useLanguage();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  const { data: employees, isLoading } = useListEmployees({
    search: search || undefined,
  });

  const getComplianceColor = (rate: number) => {
    if (rate >= 90) return 'bg-emerald-500';
    if (rate >= 70) return 'bg-amber-500';
    return 'bg-destructive';
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('common.employees')}</h1>
          <p className="text-muted-foreground mt-1">Manage staff and their compliance status.</p>
        </div>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          {t('common.add')} Employee
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-center bg-card p-4 rounded-xl border border-border shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className={cn("absolute top-3 h-4 w-4 text-muted-foreground", isRTL ? "right-3" : "left-3")} />
          <Input
            placeholder={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn("bg-background", isRTL ? "pr-9" : "pl-9")}
          />
        </div>
        <Button variant="outline" className="w-full sm:w-auto gap-2">
          <Filter className="h-4 w-4" />
          Filter
        </Button>
      </div>

      <div className="grid gap-4">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))
        ) : !employees || employees.length === 0 ? (
          <div className="text-center py-12 bg-card rounded-xl border border-dashed">
            <HeartPulse className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-20" />
            <h3 className="text-lg font-medium">No employees found</h3>
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden bg-card shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left rtl:text-right">
                <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                  <tr>
                    <th className="px-6 py-4">Employee</th>
                    <th className="px-6 py-4">Role</th>
                    <th className="px-6 py-4 hidden md:table-cell">Status</th>
                    <th className="px-6 py-4">Compliance</th>
                    <th className="px-6 py-4 text-right rtl:text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {employees.map((emp: any) => (
                    <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
                            {isRTL ? emp.nameAr[0] : emp.name[0]}
                          </div>
                          <div>
                            <div className="font-semibold text-foreground">
                              <Link href={`/employees/${emp.id}`} className="hover:text-primary hover:underline">
                                {isRTL ? emp.nameAr : emp.name}
                              </Link>
                            </div>
                            <div className="text-xs text-muted-foreground">{emp.employeeNumber || emp.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">
                        {t(`roles.${emp.role}`)}
                      </td>
                      <td className="px-6 py-4 hidden md:table-cell">
                        {emp.isAtRisk ? (
                          <Badge variant="outline" className="bg-destructive/10 text-destructive border-0 gap-1">
                            <AlertCircle className="h-3 w-3" /> At Risk
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-0">
                            Compliant
                          </Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 min-w-[150px]">
                        <div className="flex items-center gap-3">
                          <Progress 
                            value={emp.complianceRate || 0} 
                            className="h-2 flex-1" 
                            indicatorClassName={getComplianceColor(emp.complianceRate || 0)}
                          />
                          <span className="text-xs font-medium w-9">{emp.complianceRate || 0}%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right rtl:text-left">
                        <Button variant="ghost" size="sm" onClick={() => setLocation(`/employees/${emp.id}`)}>
                          {t('common.view')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
