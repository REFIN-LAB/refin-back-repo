/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { CorpCodeService } from './corp-code/corp-code.service';

export interface DartApiResponse {
  status: string;
  message: string;
  list?: any[];
  [key: string]: any;
}

@Injectable()
export class DartService {
  private readonly baseUrl = 'https://opendart.fss.or.kr/api';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly corpCodeService: CorpCodeService,
  ) {}

  async getReportList(
    corpCode: string,
    bgnDe: string,
    endDe: string,
    pageNo: number = 1,
    pageCount: number = 10,
  ): Promise<DartApiResponse> {
    const apiKey = this.configService.get<string>('DART_API_KEY');
    const url = `${this.baseUrl}/list.json`;

    const params = {
      crtfc_key: apiKey,
      corp_code: corpCode,
      bgn_de: bgnDe,
      end_de: endDe,
      last_reprt_at: 'N',
      pblntf_ty: 'A',
      corp_cls: 'Y',
      page_no: pageNo,
      page_count: pageCount,
    };

    const response = await firstValueFrom(
      this.httpService.get(url, { params }),
    );
    return response.data;
  }

  async getFinancialStatements(
    corpCode: string,
    bsnsYear: string,
    reprtCode: string,
  ): Promise<DartApiResponse> {
    const apiKey = this.configService.get<string>('DART_API_KEY');
    // 전체 재무제표 API로 변경 (상세 계정과목 조회를 위해)
    const url = `${this.baseUrl}/fnlttSinglAcntAll.json`;

    const params = {
      crtfc_key: apiKey,
      corp_code: corpCode,
      bsns_year: bsnsYear,
      reprt_code: reprtCode,
      fs_div: 'CFS', // 연결재무제표 우선 조회
    };

    try {
      const response = await firstValueFrom(
        this.httpService.get(url, { params }),
      );
      // 연결재무제표가 없으면(status 013 등) 개별재무제표(OFS) 재시도
      if (response.data.status !== '000') {
        const retryParams = { ...params, fs_div: 'OFS' };
        const retryResponse = await firstValueFrom(
          this.httpService.get(url, { params: retryParams }),
        );
        return retryResponse.data;
      }
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  async getMultiYearFinancialStatements(
    corpCode: string,
    startYear: number,
    endYear: number,
    reprtCode: string,
  ): Promise<Record<string, any>> {
    // ... (기존과 동일, 내부적으로 getFinancialStatements 호출)
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => (startYear + i).toString(),
    );

    const promises = years.map((year) =>
      this.getFinancialStatements(corpCode, year, reprtCode),
    );

    const results = await Promise.all(promises);

    return results.reduce<Record<string, any>>((acc, current, index) => {
      acc[years[index]] = current.list || current.message;
      return acc;
    }, {});
  }

  async getCompanyIndicators(
    stockCode: string,
    startYear: number,
    endYear: number,
  ) {
    const corpCode = this.corpCodeService.getCorpCode(stockCode);
    if (!corpCode) {
      throw new Error(`Company with stock code ${stockCode} not found.`);
    }

    const results: Record<string, any> = {};
    const accountsMap: Record<string, any> = {};

    // 1. 연도 및 분기별 데이터 수집
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => (startYear + i).toString(),
    );

    // 보고서 코드 매핑 (분기별)
    const quarters = [
      { code: '11013', name: '1Q' }, // 1분기보고서
      { code: '11012', name: '2Q' }, // 반기보고서
      { code: '11014', name: '3Q' }, // 3분기보고서
      { code: '11011', name: '4Q' }, // 사업보고서
    ];

    for (const year of years) {
      for (const q of quarters) {
        const key = `${year}-${q.name}`;
        try {
          const data = await this.getFinancialStatements(corpCode, year, q.code);
          if (data.list) {
            accountsMap[key] = data.list;
          }
        } catch (e) {
          console.error(`Failed to fetch data for ${key}`, e);
        }
      }
    }

    // 2. 데이터 가공 및 지표 계산
    const sortedKeys = Object.keys(accountsMap).sort();

    for (const key of sortedKeys) {
      const currentData = accountsMap[key];
      // 전년 동기 대비 증감율 계산을 위한 과거 데이터 키 (예: 2023-1Q -> 2022-1Q)
      const [year, q] = key.split('-');
      const prevYearKey = `${Number(year) - 1}-${q}`;
      const prevData = accountsMap[prevYearKey]; // (주의: API 호출 범위에 없으면 없을 수 있음)

      const indicators = {
        '매출액증가율': '0',
        '영업이익증가율': '0',
        '자기자본이익률(ROE)': '0',
        '부채비율': '0',
        '유동비율': '0',
        '매출액영업이익률': '0',
      };

      if (currentData) {
        const getValue = (list: any[], keywords: string[]) => {
          const item = list.find((i) => 
            keywords.some(k => i.account_nm.replace(/\s/g, '').includes(k))
          );
          if (item && item.thstrm_amount) {
            return parseFloat(item.thstrm_amount.toString().replace(/,/g, '')) || 0;
          }
          return 0;
        };

        // 1. 손익계산서 항목
        const revenue = getValue(currentData, ['매출액', '수익(매출액)']);
        const costOfSales = getValue(currentData, ['매출원가']);
        const grossProfit = getValue(currentData, ['매출총이익']);
        const sellingAdminExpenses = getValue(currentData, ['판매비와관리비', '판관비']);
        const operatingProfit = getValue(currentData, ['영업이익']);
        const netIncome = getValue(currentData, ['당기순이익', '순이익']);

        // 2. 재무상태표 항목
        const totalAssets = getValue(currentData, ['자산총계']);
        const currentAssets = getValue(currentData, ['유동자산']);
        const nonCurrentAssets = getValue(currentData, ['비유동자산']);
        const totalLiabilities = getValue(currentData, ['부채총계']);
        const currentLiabilities = getValue(currentData, ['유동부채']);
        const nonCurrentLiabilities = getValue(currentData, ['비유동부채']);
        const totalEquity = getValue(currentData, ['자본총계']);

        // 3. 현금흐름표 항목
        const operatingCashFlow = getValue(currentData, ['영업활동현금흐름', '영업활동으로인한현금흐름']);
        const investingCashFlow = getValue(currentData, ['투자활동현금흐름', '투자활동으로인한현금흐름']);
        const financingCashFlow = getValue(currentData, ['재무활동현금흐름', '재무활동으로인한현금흐름']);

        // 지표 계산
        if (totalEquity !== 0) {
          indicators['자기자본이익률(ROE)'] = ((netIncome / totalEquity) * 100).toFixed(2);
          indicators['부채비율'] = ((totalLiabilities / totalEquity) * 100).toFixed(2);
        }
        if (currentLiabilities !== 0) {
          indicators['유동비율'] = ((currentAssets / currentLiabilities) * 100).toFixed(2);
        }
        if (revenue !== 0) {
          indicators['매출액영업이익률'] = ((operatingProfit / revenue) * 100).toFixed(2);
        }
        
        // 전년 동기 대비 증가율 (YoY)
        if (prevData) {
          const prevRevenue = getValue(prevData, ['매출액', '수익(매출액)']);
          const prevOperatingProfit = getValue(prevData, ['영업이익']);
          if (prevRevenue !== 0) {
            indicators['매출액증가율'] = (((revenue - prevRevenue) / Math.abs(prevRevenue)) * 100).toFixed(2);
          }
          if (prevOperatingProfit !== 0) {
            indicators['영업이익증가율'] = (((operatingProfit - prevOperatingProfit) / Math.abs(prevOperatingProfit)) * 100).toFixed(2);
          }
        }

        results[key] = {
          indicators,
          income_statement: {
            revenue,
            cost_of_sales: costOfSales,
            gross_profit: grossProfit,
            selling_admin_expenses: sellingAdminExpenses,
            operating_profit: operatingProfit,
            net_income: netIncome,
          },
          balance_sheet: {
            total_assets: totalAssets,
            current_assets: currentAssets,
            non_current_assets: nonCurrentAssets,
            total_liabilities: totalLiabilities,
            current_liabilities: currentLiabilities,
            non_current_liabilities: nonCurrentLiabilities,
            total_equity: totalEquity,
          },
          cash_flow: {
            operating: operatingCashFlow,
            investing: investingCashFlow,
            financing: financingCashFlow,
          }
        };
      }
    }

    return results;
  }
}
