import { Body, Controller, Get, HttpException, Param, Post } from '@nestjs/common'
import { GadongError, RequirePermission, withTransaction } from '@gadong/kernel'
import { Inject } from '@nestjs/common'
import type { Pool } from 'pg'
import { DB_POOL } from './health.controller'
import type { CalendarView, HolidayInput } from './holidays.service'
import { HolidaysService } from './holidays.service'

interface SetCalendarBody {
  holidays: HolidayInput[]
  restDayOfWeek?: number
}

function invalidYear(year: string): GadongError {
  return new GadongError('SCH-014', 'scheduler.error.invalid_year', 422, [{ year }])
}

/** `GET /holidays/:year` -> `roster.read` (every role that can see a roster can see the holiday calendar); `POST /holidays/:year` -> `holiday.manage` (roadmap permission catalog). */
@Controller()
export class HolidaysController {
  constructor(
    private readonly holidaysService: HolidaysService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Get('holidays/:year')
  @RequirePermission('roster.read')
  async get(@Param('year') year: string): Promise<CalendarView> {
    return this.runFailClosed(() => this.holidaysService.getCalendar(this.parseYear(year)))
  }

  @Post('holidays/:year')
  @RequirePermission('holiday.manage')
  async set(@Param('year') year: string, @Body() body: SetCalendarBody): Promise<CalendarView> {
    const parsedYear = this.parseYear(year)
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) =>
        this.holidaysService.setCalendar(tx, { year: parsedYear, holidays: body.holidays, restDayOfWeek: body.restDayOfWeek }),
      ),
    )
  }

  private parseYear(year: string): number {
    const n = Number.parseInt(year, 10)
    if (!Number.isInteger(n) || String(n) !== year) throw invalidYear(year)
    return n
  }

  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}
