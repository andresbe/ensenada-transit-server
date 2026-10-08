import { Router } from "express";
import { query } from "../db";
import { authMiddleware, userAccountMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { record,text,uuid,choice } from "./validation";

export const notificationsRouter=Router();
const account=[apiRateLimiter,authMiddleware,userAccountMiddleware];
notificationsRouter.get('/devices',...account,asyncHandler(async(req,res)=>{
  res.json({devices:(await query('SELECT id,platform,active FROM passenger_devices WHERE user_id=$1',[req.user!.sub])).rows});
}));
notificationsRouter.post('/devices',...account,asyncHandler(async(req,res)=>{
  const b=record(req.body), token=text(b.token,'token',300), platform=choice(b.platform,['android','ios'],'platform');
  if(!/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(token))throw new AppError('Invalid Expo push token.',400);
  const result=await query(`INSERT INTO passenger_devices(user_id,token,platform) VALUES($1,$2,$3)
    ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,active=TRUE,updated_at=NOW() RETURNING id`,[req.user!.sub,token,platform]);
  res.status(201).json({device:result.rows[0]});
}));
notificationsRouter.delete('/devices/:id',...account,asyncHandler(async(req,res)=>{
  await query('DELETE FROM passenger_devices WHERE id=$1 AND user_id=$2',[uuid(req.params.id),req.user!.sub]);res.status(204).end();
}));
notificationsRouter.get('/notification-subscriptions',...account,asyncHandler(async(req,res)=>{
  res.json({subscriptions:(await query('SELECT route_id,created_at FROM notification_subscriptions WHERE user_id=$1 ORDER BY created_at DESC',[req.user!.sub])).rows});
}));
notificationsRouter.post('/notification-subscriptions',...account,asyncHandler(async(req,res)=>{
  const routeId=uuid(record(req.body).route_id);
  await query('INSERT INTO notification_subscriptions(user_id,route_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user!.sub,routeId]);res.status(201).json({subscribed:true});
}));
notificationsRouter.delete('/notification-subscriptions/:routeId',...account,asyncHandler(async(req,res)=>{
  await query('DELETE FROM notification_subscriptions WHERE user_id=$1 AND route_id=$2',[req.user!.sub,uuid(req.params.routeId)]);res.status(204).end();
}));
